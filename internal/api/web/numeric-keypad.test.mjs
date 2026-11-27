import test from "node:test";
import assert from "node:assert/strict";
import { allowsNegative, keypadPress } from "./modules/numeric-keypad.js";

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

test("fields without a minimum accept negative values", () => {
  const field = (min) => ({ getAttribute: (name) => (name === "min" ? min : null) });
  assert.equal(allowsNegative(field(null)), true, "Finish work Z has no minimum");
  assert.equal(allowsNegative(field("")), true);
  assert.equal(allowsNegative(field("-50")), true);
  assert.equal(allowsNegative(field("0.001")), false);
  assert.equal(allowsNegative(field("0")), false);
  assert.equal(["sign", "3", ".", "1", "7"].reduce((v, k) => keypadPress(v, k, { allowNegative: allowsNegative(field(null)) }), ""), "-3.17");
});
