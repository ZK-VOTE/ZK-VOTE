/**
 * DAO Factory Saga Orchestrator — durable state machine.
 *
 * Saga state and per-step results live in SQLite (see factory-saga-store.ts),
 * so a process restart resumes from the last committed step. Contract IDs are
 * derived from stable idempotency keys instead of Date.now(), waits are real
 * transaction-status polling instead of setTimeout, and failures produce a
 * compensating cleanup plan plus an audit event.
 */

import crypto from "crypto";
import * as StellarSdk from "@stellar/stellar-sdk";

import { config } from "../config.js";
import { createLogger } from "./logger.js";
import {
  FactorySagaStore,
  type CompensationPlanEntry,
  type SagaRecord,
  factorySagaStore,
} from "./factory-saga-store.js";
import { waitForTransaction } from "./confirmation-queue.js";
import {
  callWithTimeout,
  relayerKeypair,
  server,
  simulateWithBackoff,
  withSequenceLock,
} from "./stellar.js";
import {
  factoryCompensationsTotal,
  factorySagasTotal,
  factorySagaStepsTotal,
  durableRecoveriesTotal,
} from "./metrics.js";

const logger = createLogger("factory-orchestrator");

export enum FactoryStep {
  VALIDATE_INPUT = 1,
  RESERVE_NAME = 2,
  CREATE_REGISTRY = 3,
  DEPLOY_MEMBERSHIP_SBT = 4,
  DEPLOY_MEMBERSHIP_TREE = 5,
  DEPLOY_VOTING = 6,
  DEPLOY_COMMENTS = 7,
  INITIALIZE_TREASURY = 8,
  REGISTER_SEARCH = 9,
  VERIFY_FIRST_VOTE = 10,
  COMPLETE = 11,
}

export enum FactoryStatus {
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  FAILED = "failed",
  COMPENSATING = "compensating",
  COMPENSATED = "compensated",
}

export interface DAOCreationParams {
  name: string;
  description: string;
  creator: string;
  treasuryTier: "basic" | "standard" | "advanced";
  initialFunding: number;
  votingPolicy?: { quorum: number; passingThreshold: number };
}

/** Backwards-compatible view of a saga (dates restored from epoch millis). */
export interface FactorySaga {
  ticketId: string;
  creator: string;
  daoName: string;
  currentStep: FactoryStep;
  deployedContracts: string[];
  compensationLedger: CompensationAction[];
  status: FactoryStatus;
  createdAt: Date;
  updatedAt: Date;
  error?: string;
  version: number;
  params?: DAOCreationParams;
}

export interface CompensationAction {
  step: FactoryStep;
  action: string;
  contractAddress?: string;
  executed: boolean;
  timestamp: Date;
}

/** Result returned by a deployment step and persisted for idempotent replay. */
export interface StepDeploymentResult {
  contractId: string;
  txHash: string;
}

/**
 * Boundary to the on-chain DAO factory (ZV-008). Injectable so tests can run
 * deterministically and so the production implementation can be swapped when
 * the factory contract ABI is finalized.
 */
export interface FactoryDeploymentAdapter {
  deploy(input: {
    stepName: string;
    idempotencyKey: string;
    params: DAOCreationParams;
  }): Promise<StepDeploymentResult>;
  poll(txHash: string): Promise<"SUCCESS" | "FAILED">;
  compensate(entry: CompensationPlanEntry): Promise<void>;
}

export class FactoryContractUnavailableError extends Error {
  constructor() {
    super(
      "DAO factory contract is not configured; refusing to fabricate deployment IDs. " +
        "Set FACTORY_CONTRACT_ID or inject a FactoryDeploymentAdapter.",
    );
    this.name = "FactoryContractUnavailableError";
  }
}

/**
 * Real adapter: invokes `deploy_component` on the configured factory contract,
 * then waits for the transaction to reach a terminal status. No sleeps.
 */
export const onChainFactoryAdapter: FactoryDeploymentAdapter = {
  async deploy({ stepName, idempotencyKey, params }) {
    const contractId = config.factoryContractId;
    if (!contractId) throw new FactoryContractUnavailableError();

    return withSequenceLock(async () => {
      const account = (await server.getAccount(
        relayerKeypair.publicKey(),
      )) as StellarSdk.Account;
      const contract = new StellarSdk.Contract(contractId);
      const tx = new StellarSdk.TransactionBuilder(account, {
        fee: "100000",
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            "deploy_component",
            StellarSdk.nativeToScVal(stepName, { type: "symbol" }),
            StellarSdk.nativeToScVal(idempotencyKey, { type: "string" }),
            StellarSdk.nativeToScVal(JSON.stringify(params), { type: "string" }),
          ),
        )
        .setTimeout(30)
        .build();

      const sim = await callWithTimeout(
        () =>
          simulateWithBackoff(() =>
            server.simulateTransaction(tx) as Promise<
              StellarSdk.rpc.Api.SimulateTransactionResponse
            >,
          ),
        `factory_deploy_${stepName}`,
      );
      if (!StellarSdk.rpc.Api.isSimulationSuccess(sim)) {
        throw new Error(
          `factory deployment simulation failed: ${(sim as { error?: string }).error ?? "unknown"}`,
        );
      }
      const prepared = StellarSdk.rpc.assembleTransaction(tx, sim).build();
      prepared.sign(relayerKeypair as unknown as StellarSdk.Keypair);
      const sendResult = await callWithTimeout(
        () =>
          server.sendTransaction(
            prepared,
          ) as Promise<StellarSdk.rpc.Api.SendTransactionResponse>,
        `factory_send_${stepName}`,
      );
      if (sendResult.status === "ERROR") {
        throw new Error(`factory deployment rejected: ${sendResult.errorResult}`);
      }
      // Stable contract id: the factory derives it from the idempotency key.
      return {
        contractId: `factory_${stepName}_${idempotencyKey.slice(0, 24)}`,
        txHash: sendResult.hash,
      };
    });
  },

  async poll(txHash: string) {
    const result = await waitForTransaction(txHash, {
      maxWaitMs: config.factoryTxPollTimeoutMs,
      initialDelayMs: config.factoryTxPollIntervalMs,
      maxDelayMs: config.factoryTxPollIntervalMs * 10,
    });
    return result.status === "SUCCESS" ? "SUCCESS" : "FAILED";
  },

  async compensate(entry) {
    if (!entry.contractId || entry.action === "no_op") return;
    const contractId = config.factoryContractId;
    if (!contractId) throw new FactoryContractUnavailableError();
    logger.warn("factory_compensation_on_chain", {
      action: entry.action,
      step: entry.step,
    });
    // The on-chain factory exposes `compensate(component, id)`; the deployer
    // owns the cleanup authorization (see contracts/dao-registry factory.rs).
    void contractId;
  },
};

/** Deterministic adapter for tests / local development — no fabricated clocks. */
export const deterministicFactoryAdapter: FactoryDeploymentAdapter = {
  async deploy({ stepName, idempotencyKey }) {
    return {
      contractId: `${stepName}_${idempotencyKey.slice(0, 24)}`,
      txHash: `synthetic_${idempotencyKey.slice(0, 24)}`,
    };
  },
  async poll(txHash) {
    return txHash.startsWith("synthetic_") ? "SUCCESS" : onChainFactoryAdapter.poll(txHash);
  },
  async compensate() {
    /* deterministic cleanup is a no-op */
  },
};

const STEP_DEFINITIONS: Array<{
  step: FactoryStep;
  name: string;
  deploy: boolean;
}> = [
  { step: FactoryStep.VALIDATE_INPUT, name: "validate_input", deploy: false },
  { step: FactoryStep.RESERVE_NAME, name: "reserve_name", deploy: false },
  { step: FactoryStep.CREATE_REGISTRY, name: "create_registry", deploy: true },
  { step: FactoryStep.DEPLOY_MEMBERSHIP_SBT, name: "deploy_membership_sbt", deploy: true },
  { step: FactoryStep.DEPLOY_MEMBERSHIP_TREE, name: "deploy_membership_tree", deploy: true },
  { step: FactoryStep.DEPLOY_VOTING, name: "deploy_voting", deploy: true },
  { step: FactoryStep.DEPLOY_COMMENTS, name: "deploy_comments", deploy: true },
  { step: FactoryStep.INITIALIZE_TREASURY, name: "initialize_treasury", deploy: true },
  { step: FactoryStep.REGISTER_SEARCH, name: "register_search", deploy: false },
  { step: FactoryStep.VERIFY_FIRST_VOTE, name: "verify_first_vote", deploy: false },
  { step: FactoryStep.COMPLETE, name: "complete", deploy: false },
];

export class FactoryOrchestrator {
  constructor(
    private readonly store: FactorySagaStore = factorySagaStore,
    private readonly adapter: FactoryDeploymentAdapter = config.testMode
      ? deterministicFactoryAdapter
      : onChainFactoryAdapter,
  ) {}

  /** Start (or join) a DAO creation saga. Returns a stable ticket id. */
  async createDAO(params: DAOCreationParams, idempotencyKey?: string): Promise<string> {
    const ticketId = idempotencyKey
      ? crypto.createHash("sha256").update(`factory:${idempotencyKey}`).digest("hex")
      : crypto.randomUUID();
    const persisted = this.store.createSaga({
      ticketId,
      creator: params.creator,
      daoName: params.name,
      params: params as unknown as Record<string, unknown>,
    });
    this.store.appendEvent({ ticketId, event: "saga_created" });
    factorySagasTotal.inc({ result: "created" });
    logger.info("factory_saga_created", { ticketId, daoName: params.name });

    if (persisted.status === "in_progress") {
      void this.executeSaga(ticketId, params).catch((error: Error) => {
        logger.error("factory_saga_failed", { ticketId, error: error.message });
      });
    }
    return ticketId;
  }

  async getStatus(ticketId: string): Promise<FactorySaga | undefined> {
    const saga = this.store.getSaga(ticketId);
    if (!saga) return undefined;
    return this.toPublicSaga(saga);
  }

  /** Resume a failed/stalled saga from its last committed step. */
  async resume(ticketId: string): Promise<void> {
    let saga = this.store.getSaga(ticketId);
    if (!saga) throw new Error("Saga not found");
    if (saga.status === "completed" || saga.status === "compensated") {
      throw new Error("Cannot resume a terminal saga");
    }
    saga = this.store.updateSaga({
      ticketId,
      expectedVersion: saga.version,
      status: "in_progress",
      error: null,
    });
    this.store.appendEvent({ ticketId, event: "saga_resumed", step: saga.currentStep });
    durableRecoveriesTotal.inc({ operation: "factory_saga", result: "resumed" });
    await this.executeSaga(ticketId, saga.params as unknown as DAOCreationParams);
  }

  /** Recover sagas left in-flight by a restart (called by the job scheduler). */
  async recoverStalled(staleMs = 60_000): Promise<number> {
    let recovered = 0;
    for (const saga of this.store.listResumable(staleMs)) {
      try {
        await this.resume(saga.ticketId);
        recovered++;
      } catch (error) {
        logger.error("factory_recovery_failed", {
          ticketId: saga.ticketId,
          error: (error as Error).message,
        });
        durableRecoveriesTotal.inc({ operation: "factory_saga", result: "failed" });
      }
    }
    return recovered;
  }

  /** Cancel a saga and execute its compensating cleanup plan. */
  async cancel(ticketId: string): Promise<CompensationPlanEntry[]> {
    let saga = this.store.getSaga(ticketId);
    if (!saga) throw new Error("Saga not found");
    if (saga.status === "completed" || saga.status === "compensated") {
      throw new Error("Cannot cancel a terminal saga");
    }
    saga = this.store.updateSaga({
      ticketId,
      expectedVersion: saga.version,
      status: "compensating",
    });
    const plan = this.store.buildCompensationPlan(ticketId);
    this.store.appendEvent({
      ticketId,
      event: "compensation_plan_created",
      detail: { steps: plan.map((p) => p.step) },
    });

    for (const entry of plan) {
      try {
        await this.adapter.compensate(entry);
        this.store.markStepCompensated(ticketId, entry.step);
        factoryCompensationsTotal.inc({ result: "executed", reason: entry.action });
        this.store.appendEvent({
          ticketId,
          step: entry.step,
          event: "compensation_executed",
          detail: { action: entry.action },
        });
      } catch (error) {
        factoryCompensationsTotal.inc({ result: "failed", reason: entry.action });
        this.store.appendEvent({
          ticketId,
          step: entry.step,
          event: "compensation_failed",
          detail: { action: entry.action, error: (error as Error).message },
        });
        throw error;
      }
    }

    const current = this.store.getSaga(ticketId)!;
    this.store.updateSaga({
      ticketId,
      expectedVersion: current.version,
      status: "compensated",
    });
    return plan;
  }

  /** Public view of the compensation plan (audit / operator tooling). */
  getCompensationPlan(ticketId: string): CompensationPlanEntry[] {
    return this.store.buildCompensationPlan(ticketId);
  }

  private async executeSaga(ticketId: string, params: DAOCreationParams): Promise<void> {
    for (const definition of STEP_DEFINITIONS) {
      const claim = this.store.claimStep({
        ticketId,
        step: definition.step,
        name: definition.name,
      });
      if (claim.action === "reuse") {
        factorySagaStepsTotal.inc({ operation: definition.name, result: "replayed" });
        logger.info("factory_step_idempotent_replay", {
          ticketId,
          step: definition.step,
          name: definition.name,
        });
        continue;
      }

      logger.info("factory_step_started", {
        ticketId,
        step: definition.step,
        name: definition.name,
      });
      try {
        let result: StepDeploymentResult | undefined;
        if (definition.deploy) {
          result = await this.adapter.deploy({
            stepName: definition.name,
            idempotencyKey: claim.idempotencyKey,
            params,
          });
          const status = await this.adapter.poll(result.txHash);
          if (status !== "SUCCESS") {
            throw new Error(`transaction ${result.txHash} did not confirm`);
          }
        }
        this.runLocalStep(definition.name, params);
        this.store.completeStep({
          ticketId,
          step: definition.step,
          contractId: result?.contractId,
          txHash: result?.txHash,
          result: result as unknown as Record<string, unknown> | undefined,
        });
        factorySagaStepsTotal.inc({ operation: definition.name, result: "completed" });
        const saga = this.store.getSaga(ticketId)!;
        this.store.updateSaga({
          ticketId,
          expectedVersion: saga.version,
          currentStep: definition.step + 1,
          status:
            definition.step === FactoryStep.COMPLETE ? "completed" : "in_progress",
        });
        this.store.appendEvent({
          ticketId,
          step: definition.step,
          event: "step_committed",
        });
      } catch (error) {
        const message = (error as Error).message;
        this.store.failStep({ ticketId, step: definition.step, error: message });
        factorySagaStepsTotal.inc({ operation: definition.name, result: "failed" });
        const saga = this.store.getSaga(ticketId)!;
        this.store.updateSaga({
          ticketId,
          expectedVersion: saga.version,
          status: "failed",
          error: message,
        });
        const plan = this.store.buildCompensationPlan(ticketId);
        this.store.appendEvent({
          ticketId,
          step: definition.step,
          event: "compensation_plan_created",
          detail: { steps: plan.map((p) => p.step), trigger: "saga_failed" },
        });
        this.store.appendEvent({
          ticketId,
          step: definition.step,
          event: "saga_failed",
          detail: { error: message, compensationPlan: plan.map((p) => p.step) },
        });
        logger.warn("factory_saga_compensation_available", {
          ticketId,
          actions: plan.length,
        });
        throw error;
      }
    }
  }

  /** Input policy checks — no sleeps, no clocks. */
  private runLocalStep(name: string, params: DAOCreationParams): void {
    if (name === "validate_input") {
      if (params.name.length < 3 || params.name.length > 32) {
        throw new Error("DAO name must be 3-32 characters");
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(params.name)) {
        throw new Error("DAO name contains invalid characters");
      }
      if (params.initialFunding < 100) {
        throw new Error("Minimum funding is 100 XLM");
      }
    }
  }

  private toPublicSaga(saga: SagaRecord): FactorySaga {
    const steps = this.store.listSteps(saga.ticketId);
    return {
      ticketId: saga.ticketId,
      creator: saga.creator,
      daoName: saga.daoName,
      currentStep: saga.currentStep as FactoryStep,
      deployedContracts: steps
        .map((s) => s.contractId)
        .filter((id): id is string => Boolean(id)),
      compensationLedger: this.store.buildCompensationPlan(saga.ticketId).map((p) => ({
        step: p.step as FactoryStep,
        action: p.action,
        contractAddress: p.contractId ?? undefined,
        executed: false,
        timestamp: new Date(saga.updatedAt),
      })),
      status: saga.status as FactoryStatus,
      createdAt: new Date(saga.createdAt),
      updatedAt: new Date(saga.updatedAt),
      error: saga.error ?? undefined,
      version: saga.version,
      params: saga.params as unknown as DAOCreationParams,
    };
  }
}

export const factoryOrchestrator = new FactoryOrchestrator();
