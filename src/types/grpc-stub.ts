import type * as grpc from '@grpc/grpc-js'

/** Minimal gRPC client surface used by mtdd (proto-loader generated). */
export interface MtddShardClient {
  Connect(
    request: Record<string, unknown>,
    metadata: { deadline: number },
    callback: (err: grpc.ServiceError | null, response: { ok?: boolean; message?: string }) => void,
  ): void
  QueryStream(
    request: Record<string, unknown>,
    metadata: { deadline: number },
  ): grpc.ClientReadableStream<Record<string, unknown>>
  close(): void
}

export interface MtddNotifyClient {
  Subscribe(
    request: Record<string, unknown>,
    metadata: { deadline: number },
    callback: (err: grpc.ServiceError | null, response: Record<string, unknown>) => void,
  ): void
  Unsubscribe(
    request: Record<string, unknown>,
    metadata: { deadline: number },
    callback: (err: grpc.ServiceError | null, response: Record<string, unknown>) => void,
  ): void
  UnsubscribeAll(
    request: Record<string, unknown>,
    metadata: { deadline: number },
    callback: (err: grpc.ServiceError | null, response: Record<string, unknown>) => void,
  ): void
  Watch(
    request: Record<string, unknown>,
    metadata?: { deadline?: number },
  ): grpc.ClientReadableStream<Record<string, unknown>>
  close(): void
}

export interface MtddProtoPackage {
  MtddShard: new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ) => MtddShardClient
  MtddNotify: new (
    address: string,
    credentials: grpc.ChannelCredentials,
  ) => MtddNotifyClient
}
