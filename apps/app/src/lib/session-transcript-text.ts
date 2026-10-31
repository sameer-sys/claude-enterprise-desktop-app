import type { UIMessage } from "ai";

/**
 * Convert visible transcript content into plain text for clipboard and
 * OpenWork's session read tools. Internal reasoning remains a separate UI
 * disclosure and must never be flattened into user-visible/readback text.
 */
export function messageToReadableText(message: UIMessage): string {
  const header = message.role === "user" ? "You" : message.role === "assistant" ? "OpenWork" : message.role;
  const body = message.parts
    .flatMap((part) => {
      if (part.type === "text") return [part.text];
      // Reasoning parts are deliberately omitted. They are not assistant
      // answers and must not be copied or fed back through session.read_transcript.
      if (part.type === "reasoning") return [];
      if (part.type === "file") {
        const name = part.filename?.trim() || "file";
        const url = part.url.startsWith("data:")
          ? `data:${part.mediaType || "application/octet-stream"};base64,…`
          : part.url;
        return [`[file:${name}] ${url}`];
      }
      if (part.type === "dynamic-tool") {
        if (part.state === "output-error") return [`[tool:${part.toolName}] ${part.errorText}`];
        if (part.state === "output-available") return [`[tool:${part.toolName}] ${JSON.stringify(part.output)}`];
        return [`[tool:${part.toolName}] ${JSON.stringify(part.input)}`];
      }
      return [];
    })
    .join("\n\n");
  return `${header}\n${body}`.trim();
}

export function transcriptToText(messages: UIMessage[]): string {
  return messages
    .flatMap((message) => {
      const text = messageToReadableText(message);
      return text ? [text] : [];
    })
    .join("\n\n---\n\n");
}
