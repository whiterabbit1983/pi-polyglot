import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { fileURLToPath } from 'node:url';
import type { Transport } from '../rpc.ts';
import { token, validateEndpoint, type Connection } from '../config.ts';
import { MAX_BYTES } from '../protocol.ts';
import { SerialWriter } from './framing.ts';

export const protoPath = fileURLToPath(new URL('../../proto/extension.proto', import.meta.url));
export function grpcDefinition() {
  const loaded = grpc.loadPackageDefinition(loadSync(protoPath));
  return (loaded.pi as any).polyglot.v1.Extension as grpc.ServiceClientConstructor;
}
export class GrpcTransport implements Transport {
  onMessage?: (data: string) => void;
  onClose?: (error: Error) => void;
  private client: grpc.Client;
  private stream: grpc.ClientDuplexStream<{ json: string }, { json: string }>;
  private writer: SerialWriter;
  constructor(config: Extract<Connection, { transport: 'grpc' }>) {
    validateEndpoint(config);
    const secret = token(config);
    const Client = grpcDefinition();
    this.client = new Client(config.address, config.tls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure(), {
      'grpc.max_receive_message_length': MAX_BYTES + 16, 'grpc.max_send_message_length': MAX_BYTES + 16,
      'grpc.enable_retries': 0,
    });
    const metadata = new grpc.Metadata();
    if (secret) metadata.set('authorization', `Bearer ${secret}`);
    this.stream = (this.client as any).Connect(metadata);
    this.writer = new SerialWriter(data => new Promise((resolve, reject) => {
      this.stream.write({ json: data }, (error: Error | null | undefined) => error ? reject(error) : resolve());
    }));
    this.stream.on('data', frame => {
      if (typeof frame.json !== 'string' || Buffer.byteLength(frame.json) > MAX_BYTES) {
        this.onClose?.(new Error('Invalid gRPC frame')); void this.close(); return;
      }
      this.onMessage?.(frame.json);
    });
    this.stream.on('error', () => this.onClose?.(new Error('gRPC stream failed (check endpoint and authentication)')));
    this.stream.on('end', () => this.onClose?.(new Error('gRPC stream ended')));
  }
  send(data: string) { return this.writer.send(data); }
  async close() { this.stream.cancel(); this.client.close(); }
}
