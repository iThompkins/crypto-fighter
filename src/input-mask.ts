export const LEFT = 1;
export const RIGHT = 2;
export const ATTACK = 4;
export const UP = 8;

export const KNOWN_MASK = 0x0f;

export function isValidV1InputMask(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= KNOWN_MASK
  );
}
