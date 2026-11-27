import test from "node:test";
import assert from "node:assert/strict";
import { keypadPress } from "./modules/numeric-keypad.js";

const type = (keys, options) => keys.reduce((value, key) => keypadPress(value, key, options), "");

test("the number pad builds decimal and negative values", () => {
  assert.equal(type(["1", ".", "2", "5"]), "1.25");
  assert.equal(type([".", "5"]), "0.5");
  assert.equal(type(["3", ".", ".", "1"]), "3.1", "one decimal point");
  assert.equal(type(["0", "0", "7"]), "7", "no leading zeros");
  assert.equal(type(["sign", "3", ".", "1", "7"]), "-3.17");
  assert.equal(type(["2", "sign", "sign"]), "2");
  assert.equal(type(["2", "sign"], { allowNegative: false }), "2", "fields with a positive minimum stay positive");
  assert.equal(type(["1", "2", "back"]), "1");
  assert.equal(type(["1", "2", "clear"]), "");
});
