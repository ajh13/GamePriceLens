/**
 * Error raised when assertion fails
 */
class AssertionError extends Error {
  constructor(received: any, expected?: any, message?: string) {
    const detail =
      expected !== undefined
        ? `Expected: "${expected}" - Received: "${received}"`
        : `Received: "${received}"`
    // When a custom message is supplied, surface it ahead of the detail.
    super(message ? `${message}\n${detail}` : detail)
    this.name = "AssertionError"
    // Set the prototype explicitly to maintain the correct prototype chain
    Object.setPrototypeOf(this, AssertionError.prototype)
  }
}

/**
 * Deep equality check for objects.
 *
 * @param value - value to compare.
 * @param expected - expected value of {@link value}.
 * @returns true if the values are deeply equal, false otherwise.
 */
function deepEqual(value: any, expected: any): boolean {
  if (value === expected) {
    return true
  }
  if (
    typeof value !== "object" ||
    typeof expected !== "object" ||
    value === null ||
    expected === null
  ) {
    return false
  }

  const keysValue = Object.keys(value)
  const keysExpected = Object.keys(expected)
  if (keysValue.length !== keysExpected.length) {
    return false
  }

  for (const key of keysValue) {
    if (!keysExpected.includes(key) || !deepEqual(value[key], expected[key])) {
      return false
    }
  }
  return true
}

const FALSY_DESCRIPTION =
  'to be a falsy value (false, 0, "", null, undefined, or NaN)'
const TRUTHY_DESCRIPTION =
  'to be a truthy value (anything but false, 0, "", null, undefined, or NaN)'

/**
 * Provides way to test a value, based on its expectations.
 */
class Expectation {
  private shouldBeTrue = true
  constructor(
    private received: any,
    private message?: string,
  ) {}

  /**
   * Test the opposite of an expectation. E.g.: expect(value).not.toBe("hello").
   * @returns the instance of the expectation, negated.
   */
  get not(): Expectation {
    this.shouldBeTrue = false
    return this
  }

  /**
   * Compare primitive values or to check referential identity of object instances.
   * @throws if {@link received} and {@link expected} are the same.
   *
   * @param expected - expected value of the object.
   */
  toBe(expected: any): void {
    if (this.shouldBeTrue !== (this.received === expected)) {
      throw new AssertionError(this.received, expected, this.message)
    }
  }

  /**
   * Check if a value is null, as defined by LensCore.
   * @throws if {@link received} is not null.
   */
  toBeNull(): void {
    if (this.shouldBeTrue !== isNull(this.received)) {
      throw new AssertionError(this.received, undefined, this.message)
    }
  }

  /**
   * Check if received value is greater than the expected value.
   * @throws if {@link received} is less than {@link expected}.
   *
   * @param expected - expected value of the object.
   */

  toBeGreaterThan(expected: number): void {
    if (this.shouldBeTrue !== this.received > expected) {
      throw new AssertionError(this.received, `> ${expected}`, this.message)
    }
  }

  /**
   * Check if received value is less than the expected value.
   * @throws if {@link received} is greater than or equal to {@link expected}.
   *
   * @param expected - expected value of the object.
   */
  toBeLessThan(expected: number): void {
    if (this.shouldBeTrue !== this.received < expected) {
      throw new AssertionError(this.received, `< ${expected}`, this.message)
    }
  }

  /**
   * Check if received value is within a range, bounds included.
   * @throws if {@link received} is less than {@link floor} or greater than {@link ceiling}.
   * @throws if {@link floor} or {@link ceiling} is NaN, or floor is greater than ceiling.
   *
   * @param floor - lowest accepted value.
   * @param ceiling - highest accepted value.
   */
  toBeWithinRange(floor: number, ceiling: number): void {
    // Negated so a NaN or undefined bound is rejected too.
    if (!(floor <= ceiling)) {
      throw new Error(`toBeWithinRange: invalid range [${floor}, ${ceiling}]`)
    }
    const isWithinRange = this.received >= floor && this.received <= ceiling
    if (this.shouldBeTrue !== isWithinRange) {
      throw new AssertionError(
        this.received,
        `in range [${floor}, ${ceiling}]`,
        this.message,
      )
    }
  }

  /**
   * Deep-compare two objects.
   * @throws if {@link received} and {@link expected} are not the same.
   *
   * @param expected - expected value of the object.
   */
  toEqual(expected: any): void {
    if (this.shouldBeTrue !== deepEqual(this.received, expected)) {
      throw new AssertionError(this.received, expected, this.message)
    }
  }

  /**
   * Compare floating point numbers for approximate equality.
   *
   * @param expected - expected float value.
   * @param numDigits - Limits the number of digits to check after the decimal point.
   */
  toBeCloseTo(expected: number, numDigits = 2): void {
    if (
      this.shouldBeTrue !==
      Math.abs(expected - this.received) < 10 ** -numDigits / 2
    ) {
      throw new AssertionError(this.received, expected, this.message)
    }
  }

  /**
   * Assert that the received value is a falsy value.
   * There are six falsy values: false, 0, '', null, undefined, and NaN.
   * @throws if the received value is not falsy.
   */
  toBeFalsy(): void {
    if (this.shouldBeTrue !== !this.received) {
      throw new AssertionError(
        this.received,
        this.shouldBeTrue ? FALSY_DESCRIPTION : `NOT ${FALSY_DESCRIPTION}`,
        this.message,
      )
    }
  }

  /**
   * Assert that the received value is a truthy value.
   * There are six falsy values: false, 0, '', null, undefined, and NaN. Everything else is truthy.
   * @throws if the received value is falsy.
   */
  toBeTruthy(): void {
    if (this.shouldBeTrue !== !!this.received) {
      throw new AssertionError(
        this.received,
        this.shouldBeTrue ? TRUTHY_DESCRIPTION : `NOT ${TRUTHY_DESCRIPTION}`,
        this.message,
      )
    }
  }
}

/**
 * Use to test a value.
 *
 * @param value - value to test.
 * @param message - optional custom message surfaced ahead of the failure
 * detail when the assertion fails. E.g.: expect(id, `bad id: ${id}`).toBe(1).
 * @returns - an object with matchers.
 */
export function expect(value: any, message?: string): Expectation {
  return new Expectation(value, message)
}
