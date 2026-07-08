#!/usr/bin/env node

/**
 * Set verification key for Public DAO (DAO #1)
 *
 * This script sets the Groth16 verification key for the Public DAO,
 * which is required before proposals can be created.
 *
 * Usage: cd backend && node src/set-public-dao-vk.js
 */

import * as StellarSdk from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// Get __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load configuration from .env file
dotenv.config({ path: path.join(__dirname, '../.env') });

const VOTING_CONTRACT_ID = process.env.VOTING_CONTRACT_ID;
const RPC_URL = process.env.SOROBAN_RPC_URL;
const NETWORK_PASSPHRASE = process.env.NETWORK_PASSPHRASE;
const SECRET_KEY = process.env.ADMIN_SECRET_KEY;

if (!VOTING_CONTRACT_ID) {
  console.error('ERROR: VOTING_CONTRACT_ID not set in environment');
  process.exit(1);
}
if (!RPC_URL) {
  console.error('ERROR: SOROBAN_RPC_URL not set in environment');
  process.exit(1);
}
if (!NETWORK_PASSPHRASE) {
  console.error('ERROR: NETWORK_PASSPHRASE not set in environment');
  process.exit(1);
}
if (!SECRET_KEY) {
  console.error('ERROR: ADMIN_SECRET_KEY not set in environment');
  process.exit(1);
}

// Load verification key
const vkPath = path.join(__dirname, '../../frontend/src/lib/verification_key_soroban.json');
const vk = JSON.parse(fs.readFileSync(vkPath, 'utf8'));

async function setVerificationKey() {
  try {
    console.log('Setting verification key for Public DAO (DAO #1)...');
    console.log('Voting Contract:', VOTING_CONTRACT_ID);
    console.log('RPC URL:', RPC_URL);

    // Initialize RPC client
    const server = new StellarSdk.rpc.Server(RPC_URL, { allowHttp: true });

    // Load keypair
    const sourceKeypair = StellarSdk.Keypair.fromSecret(SECRET_KEY);
    const sourceAccount = await server.getAccount(sourceKeypair.publicKey());

    // Initialize contract
    const contract = new StellarSdk.Contract(VOTING_CONTRACT_ID);

    // Convert hex strings to Buffers
    const vkBuffers = {
      alpha: Buffer.from(vk.alpha, 'hex'),
      beta: Buffer.from(vk.beta, 'hex'),
      gamma: Buffer.from(vk.gamma, 'hex'),
      delta: Buffer.from(vk.delta, 'hex'),
      ic: vk.ic.map(ic => Buffer.from(ic, 'hex')),
    };

    console.log('Building transaction...');

    // Build transaction
    let transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: '10000000', // 10 XLM
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        contract.call(
          'set_vk',
          ...[
            1, // dao_id
            vkBuffers.alpha,
            vkBuffers.beta,
            vkBuffers.gamma,
            vkBuffers.delta,
            vkBuffers.ic,
          ]
        )
      )
      .setTimeout(30)
      .build();

    console.log('Simulating transaction...');

    // Simulate transaction
    const simulationResponse = await server.simulateTransaction(transaction);

    if (StellarSdk.rpc.Api.isSimulationError(simulationResponse)) {
      console.error('Simulation error:', simulationResponse.error);
      throw new Error(`Simulation failed: ${simulationResponse.error}`);
    }

    // Prepare transaction with simulation results
    transaction = StellarSdk.rpc.assembleTransaction(transaction, simulationResponse).build();

    // Sign transaction
    transaction.sign(sourceKeypair);

    console.log('Sending transaction...');

    // Send transaction
    const sendResponse = await server.sendTransaction(transaction);

    if (sendResponse.status === 'ERROR') {
      console.error('Transaction error:', sendResponse);
      throw new Error(`Transaction failed: ${JSON.stringify(sendResponse)}`);
    }

    console.log('Transaction sent! Hash:', sendResponse.hash);
    console.log('Waiting for confirmation...');

    // Poll for transaction result
    let getResponse = await server.getTransaction(sendResponse.hash);
    let attempts = 0;
    const maxAttempts = 30;

    while (getResponse.status === StellarSdk.rpc.Api.GetTransactionStatus.NOT_FOUND && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      getResponse = await server.getTransaction(sendResponse.hash);
      attempts++;
    }

    if (getResponse.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
      console.log('✅ Verification key set successfully for Public DAO!');
      console.log('You can now create proposals in the Public DAO.');
    } else {
      console.error('Transaction status:', getResponse.status);
      if (getResponse.status === StellarSdk.rpc.Api.GetTransactionStatus.FAILED) {
        console.error('Transaction failed:', getResponse);
      }
      throw new Error('Transaction did not succeed');
    }
  } catch (error) {
    console.error('Error setting verification key:', error);
    process.exit(1);
  }
}

// Run the script
setVerificationKey();
