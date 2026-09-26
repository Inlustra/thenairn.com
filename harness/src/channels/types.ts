// A way to reach a person. WhatsApp in production; the local test channel in
// tests. Numbers are digits only, country code first.
export interface Channel {
  name: string;
  send(number: string, text: string): Promise<void>;
  typing?(number: string, until: Promise<unknown>): void;
  sendContact?(number: string): Promise<void>; // Milo's contact card
  sendImage?(number: string, url: string, caption: string): Promise<void>;
}
