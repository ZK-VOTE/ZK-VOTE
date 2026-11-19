declare module 'snarkjs' {
  export const groth16: {
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: unknown,
    ): Promise<boolean>
  }
}
