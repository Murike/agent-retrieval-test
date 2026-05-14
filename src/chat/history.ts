import type { CoreMessage } from "ai";

export class ChatHistory {
  private messages: CoreMessage[] = [];

  get(): CoreMessage[] {
    return this.messages;
  }

  append(...msgs: CoreMessage[]): void {
    this.messages.push(...msgs);
  }

  replace(msgs: CoreMessage[]): void {
    this.messages = [...msgs];
  }

  reset(): void {
    this.messages = [];
  }

  size(): number {
    return this.messages.length;
  }
}
