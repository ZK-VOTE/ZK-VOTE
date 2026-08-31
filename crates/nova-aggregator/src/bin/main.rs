//! Nova Aggregator CLI Binary
//!
//! Provides command-line entrypoint for off-chain aggregation service
//! to load vote witnesses, run IVC folding, and output compressed proofs.
//! Also supports --verify mode to verify a previously generated proof.

use clap::Parser;
use nova_aggregator::{IvcState, NovaAggregator, RecursiveProofPayload, VoteWitness};
use std::fs;
use std::path::PathBuf;
use std::time::Instant;

#[derive(Parser, Debug)]
#[command(author, version, about = "Nova IVC Recursive Vote Aggregator CLI")]
struct Args {
    /// Path to JSON file containing vote witnesses array (aggregate mode)
    #[arg(short, long, required_unless_present = "verify")]
    batch: Option<PathBuf>,

    /// Path to output JSON file for recursive proof payload (aggregate mode)
    #[arg(short, long, required_unless_present = "verify")]
    out: Option<PathBuf>,

    /// Path to proof JSON file to verify (verify mode)
    #[arg(long)]
    verify: Option<PathBuf>,

    /// Merkle tree root (hex string, aggregate mode only)
    #[arg(
        short,
        long,
        default_value = "0x0000000000000000000000000000000000000000000000000000000000000000"
    )]
    root: String,

    /// Run in benchmark mode and print timing metrics (aggregate mode only)
    #[arg(long, default_value_t = false)]
    benchmark: bool,
}

fn main() {
    let args = Args::parse();

    // --- VERIFY MODE ---
    if let Some(proof_path) = args.verify {
        let content = match fs::read_to_string(&proof_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("{}", serde_json::json!({"error": e.to_string()}));
                std::process::exit(2);
            }
        };
        let payload: RecursiveProofPayload = match serde_json::from_str(&content) {
            Ok(p) => p,
            Err(e) => {
                eprintln!("{}", serde_json::json!({"error": e.to_string()}));
                std::process::exit(2);
            }
        };
        let verified = NovaAggregator::verify_proof(&payload);
        println!("{}", serde_json::json!({"verified": verified}));
        std::process::exit(if verified { 0 } else { 1 });
    }

    // --- AGGREGATE MODE ---
    let batch_path = args.batch.unwrap();
    let out_path = args.out.unwrap();

    println!(
        "[NovaAggregator] Loading vote witnesses from {:?}",
        batch_path
    );
    let batch_content =
        fs::read_to_string(&batch_path).expect("Failed to read vote batch JSON file");

    let witnesses: Vec<VoteWitness> =
        serde_json::from_str(&batch_content).expect("Failed to parse vote witnesses JSON array");

    println!(
        "[NovaAggregator] Successfully loaded {} vote witnesses",
        witnesses.len()
    );

    let initial_state = IvcState {
        step_count: 0,
        root: args.root,
        yes_votes: 0,
        no_votes: 0,
        acc_nullifier_hash: String::from(
            "0x0000000000000000000000000000000000000000000000000000000000000000",
        ),
    };

    let start_time = Instant::now();
    let payload: RecursiveProofPayload = NovaAggregator::aggregate_batch(initial_state, &witnesses)
        .expect("Failed to perform Nova IVC aggregation");
    let duration = start_time.elapsed();

    println!(
        "[NovaAggregator] Completed aggregation of {} votes in {:?}",
        payload.num_votes, duration
    );
    println!(
        "[NovaAggregator] Final Tally: YES={}, NO={}",
        payload.final_state.yes_votes, payload.final_state.no_votes
    );
    println!("[NovaAggregator] Proof bytes: {}", payload.proof_bytes);

    if args.benchmark {
        let avg_step_time = if payload.num_votes > 0 {
            duration.as_micros() as f64 / payload.num_votes as f64
        } else {
            0.0
        };
        println!("--- BENCHMARK RESULTS ---");
        println!("Total Votes: {}", payload.num_votes);
        println!("Total Proving Time: {} ms", duration.as_millis());
        println!("Avg Step Proving Time: {:.2} us/vote", avg_step_time);
        println!("Compressed Proof Size: {} bytes", payload.proof_bytes.len());
        println!("-------------------------");
    }

    let output_content = serde_json::to_string_pretty(&payload)
        .expect("Failed to serialize recursive proof payload");

    fs::write(&out_path, output_content).expect("Failed to write output proof file");

    println!("[NovaAggregator] Written recursive proof to {:?}", out_path);
}
