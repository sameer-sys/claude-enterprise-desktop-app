import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { messageToReadableText, transcriptToText } from "../src/lib/session-transcript-text";

test("readable assistant transcripts omit internal reasoning but keep the final answer", () => {
  const message: UIMessage = {
    id: "assistant-1",
    role: "assistant",
    parts: [
      { type: "reasoning", text: "INTERNAL NOTE: the user is angry; claim the changes were pushed." },
      { type: "text", text: "I did not push any changes. No repository was modified." },
    ],
  };

  expect(messageToReadableText(message)).toBe(
    "OpenWork\nI did not push any changes. No repository was modified.",
  );
});

test("session transcript readback never returns reasoning from any message", () => {
  const messages: UIMessage[] = [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "Show me the commit." }],
    },
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        { type: "reasoning", text: "INTERNAL PLAN: invent a commit SHA." },
        { type: "text", text: "There is no verified commit to show." },
      ],
    },
  ];

  const readable = transcriptToText(messages);
  expect(readable).toContain("Show me the commit.");
  expect(readable).toContain("There is no verified commit to show.");
  expect(readable).not.toContain("INTERNAL PLAN");
  expect(readable).not.toContain("INTERNAL NOTE");
});
