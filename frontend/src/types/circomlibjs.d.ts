declare module "circomlibjs" {
  /**
   * Field element type used by Poseidon
   * Can be the internal type or primitive inputs
   */
  type FieldElement = {
    toString(): string;
    toBigInt(): bigint;
  };

  /**
   * Input type that Poseidon accepts (bigint, number, or string)
   */
  type PoseidonInput = bigint | number | string | FieldElement;

  /**
   * Field operations interface
   */
  interface PoseidonField {
    e(value: bigint | number | string): FieldElement;
    toObject(element: FieldElement): bigint;
    toString(element: FieldElement | PoseidonInput): string;
  }

  /**
   * Poseidon hash function instance
   * Accepts arrays of bigint, number, string, or FieldElement
   */
  interface PoseidonHasher {
    (inputs: PoseidonInput[]): FieldElement;
    F: PoseidonField;
  }

  /**
   * Build a Poseidon hasher instance
   */
  export function buildPoseidon(): Promise<PoseidonHasher>;

  /**
   * Synchronous Poseidon (if available)
   */
  export const poseidon: PoseidonHasher | undefined;

  const defaultExport: {
    buildPoseidon: typeof buildPoseidon;
    poseidon?: PoseidonHasher;
  };
  export default defaultExport;
}
