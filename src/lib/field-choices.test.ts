import assert from "node:assert/strict";
import test from "node:test";

import {
  countAnswerableFields,
  describeChoiceFieldProblem,
  describeEntryProblem,
  DROPDOWN_ENTRY_MESSAGE,
  findChoiceFieldProblem,
  isNumberEntry,
  judgeRadioGroups,
  labelTextToShow,
  MAX_FIELD_OPTIONS,
  NUMBER_ENTRY_MESSAGE,
  optionsTextToShow,
  parseOptionLines,
} from "./field-choices.ts";

test("an editor box shows what was typed only while it still stands for what is saved", () => {
  const saved = ["Monthly", "Yearly"];

  // Mid-thought: the empty line and the trailing space are kept.
  assert.equal(
    optionsTextToShow("Monthly\nYearly \n", saved),
    "Monthly\nYearly \n",
  );
  // The other copy of the editor: never typed in, or typed in a while ago.
  assert.equal(optionsTextToShow("", saved), "Monthly\nYearly");
  assert.equal(
    optionsTextToShow("Monthly\nYearly", [...saved, "Once"]),
    "Monthly\nYearly\nOnce",
  );
  assert.equal(optionsTextToShow("Yearly\nMonthly", saved), "Monthly\nYearly");
  assert.equal(optionsTextToShow("Old", null), "");
  assert.equal(optionsTextToShow(" \n", []), " \n");

  assert.equal(labelTextToShow("Yes ", "Yes"), "Yes ");
  assert.equal(labelTextToShow("", "Yes"), "Yes");
  assert.equal(labelTextToShow("Ye", "Yes"), "Yes");
  assert.equal(labelTextToShow("Old", undefined), "");
  assert.equal(labelTextToShow("  ", null), "  ");
});

test("a number field takes plain and comma-grouped numbers and nothing else", () => {
  for (const entry of [
    "0",
    "1250",
    "12.5",
    "-3",
    "+7.25",
    " 42 ",
    "1,250",
    "1,250,000.75",
    "-12,000",
  ]) {
    assert.equal(isNumberEntry(entry), true, entry);
  }

  for (const entry of [
    "",
    "abc",
    "12,5",
    "1,25",
    "1.2.3",
    "12.",
    ".5",
    "1e5",
    "1 250",
    "12,5000",
    "٣",
    "12%",
    "$12",
    "--1",
    "1".repeat(19),
  ]) {
    assert.equal(isNumberEntry(entry), false, entry);
  }
});

test("choices are read one per line, without blanks or repeats", () => {
  assert.deepEqual(parseOptionLines(" Yes \n\nNo\r\nYes\n  Maybe"), [
    "Yes",
    "No",
    "Maybe",
  ]);
  assert.deepEqual(parseOptionLines(""), []);
  assert.equal(
    parseOptionLines(
      Array.from({ length: 40 }, (_, index) => `Choice ${index}`).join("\n"),
    ).length,
    MAX_FIELD_OPTIONS,
  );
  assert.equal(parseOptionLines("x".repeat(200))[0].length, 80);
});

test("a dropdown needs two choices and a radio button needs company", () => {
  const signerId = "signer-1";

  assert.equal(findChoiceFieldProblem([]), null);
  assert.equal(
    findChoiceFieldProblem([
      { options: ["Yes", "No"], required: true, signerId, type: "dropdown" },
      { groupId: "g1", required: true, signerId, type: "radio" },
      { groupId: "g1", required: true, signerId, type: "radio" },
      { required: true, signerId, type: "signature" },
    ]),
    null,
  );

  for (const options of [undefined, null, [], ["Only"]]) {
    assert.deepEqual(
      findChoiceFieldProblem([
        { options, required: false, signerId, type: "dropdown" },
      ]),
      { kind: "dropdown_options", signerId },
    );
  }

  const lonely = findChoiceFieldProblem([
    { groupId: "g1", required: true, signerId, type: "radio" },
    { groupId: "g1", required: true, signerId, type: "radio" },
    { groupId: "g2", required: true, signerId: "signer-2", type: "radio" },
  ]);

  assert.deepEqual(lonely, { kind: "radio_group_size", signerId: "signer-2" });
  assert.match(describeChoiceFieldProblem(lonely!, "Ada"), /Ada/);
});

test("a group of radio buttons counts as one thing to do", () => {
  const signerId = "signer-1";

  assert.equal(
    countAnswerableFields(
      [
        { required: true, signerId, type: "signature" },
        { groupId: "g1", required: true, signerId, type: "radio" },
        { groupId: "g1", required: true, signerId, type: "radio" },
        { groupId: "g1", required: true, signerId, type: "radio" },
        { groupId: "g2", required: true, signerId, type: "radio" },
        { groupId: "g2", required: true, signerId, type: "radio" },
        { required: false, signerId, type: "checkbox" },
      ],
      (field) => field.required,
    ),
    3,
  );
});

test("what a signer enters must be a number, or one of the choices offered", () => {
  assert.equal(describeEntryProblem({ type: "number" }, "12.5"), null);
  assert.equal(
    describeEntryProblem({ type: "number" }, "twelve"),
    NUMBER_ENTRY_MESSAGE,
  );
  assert.equal(
    describeEntryProblem({ options: ["Yes", "No"], type: "dropdown" }, "Yes"),
    null,
  );

  for (const [options, value] of [
    [["Yes", "No"], "Maybe"],
    [["Yes", "No"], "yes"],
    [[], "Yes"],
    [undefined, "Yes"],
  ] as const) {
    assert.equal(
      describeEntryProblem({ options, type: "dropdown" }, value),
      DROPDOWN_ENTRY_MESSAGE,
    );
  }

  // Free text has no rule of this kind.
  assert.equal(describeEntryProblem({ type: "text" }, "anything"), null);
});

test("radio buttons are judged a group at a time", () => {
  const signerId = "signer-1";
  const button = (id: string, groupId: string, required: boolean) => ({
    groupId,
    id,
    required,
    signerId,
    type: "radio",
  });
  const fields = [
    button("a1", "a", true),
    button("a2", "a", true),
    button("b1", "b", false),
    button("b2", "b", false),
    { id: "sig", required: true, signerId, type: "signature" },
  ];
  const judge = (...chosen: string[]) =>
    judgeRadioGroups(fields, (field) => chosen.includes(field.id));

  assert.equal(judge("a1"), "ok");
  assert.equal(judge("a2", "b1"), "ok");
  // The required group has no answer.
  assert.equal(judge(), "missing");
  assert.equal(judge("b2"), "missing");
  // Two answers in one group, required or not.
  assert.equal(judge("a1", "a2"), "too_many");
  assert.equal(judge("a1", "b1", "b2"), "too_many");
  // Too many wins over missing: it is the one that cannot be a mistake.
  assert.equal(judge("b1", "b2"), "too_many");
});
