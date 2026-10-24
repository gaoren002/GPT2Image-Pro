/** 纯协议模块类型；与 inference-protocol.mjs 同步。 */
export const MAX_INPUT_BYTES: number;
export const MAX_OUTPUT_BYTES: number;
export const INPUT_FORMATS: readonly string[];
export type InferenceOperation = "restoration" | "matte" | "super-resolution";
export const LIMITS: Readonly<
  Record<
    InferenceOperation,
    {
      readonly maxEdge: number;
      readonly maxPixels: number;
      readonly scale: number;
    }
  >
>;
export function validDimensions(
  operation: InferenceOperation,
  metadata: {
    width?: number;
    height?: number;
    pages?: number;
  }
): boolean;
export function checkTensor(
  tensor: { data: unknown; dims: readonly number[] },
  shape: readonly number[]
): void;
