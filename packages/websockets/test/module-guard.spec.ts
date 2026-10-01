import {
  CanActivate,
  Injectable,
  Module,
  Scope,
  type Type,
  type WebSocketAdapter,
  type WsMessageHandler,
} from '@nestjs/common';
import { APP_GUARD, MODULE_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { SubscribeMessage, WebSocketGateway } from '../index.js';
import { from, lastValueFrom, type Observable } from 'rxjs';

describe('MODULE_GUARD with websocket gateways', () => {
  class HandlerCapturingAdapter implements WebSocketAdapter<object, object> {
    private readonly connectionHandlers: Function[] = [];
    public readonly emittedToClient: unknown[][] = [];
    private readonly handlersByMessage = new Map<string, WsMessageHandler>();

    public create() {
      return {};
    }
    public bindClientConnect(_server: object, callback: Function) {
      this.connectionHandlers.push(callback);
    }
    public bindMessageHandlers(
      _client: object,
      handlers: WsMessageHandler[],
      _transform: (data: unknown) => Observable<unknown>,
    ) {
      handlers.forEach(handler =>
        this.handlersByMessage.set(handler.message, handler),
      );
    }
    public close() {}
    public async dispose() {}

    public connectClient() {
      const client = {
        emit: (...args: unknown[]) => this.emittedToClient.push(args),
      };
      this.connectionHandlers.forEach(handler => handler(client));
    }
    public handle(message: string): Promise<unknown> {
      const handler = this.handlersByMessage.get(message);
      if (!handler) {
        return Promise.reject(
          new Error(`No handler was bound for "${message}"`),
        );
      }
      return lastValueFrom(from(handler.callback('payload')));
    }
  }

  const createGuardClass = (
    name: string,
    calls: string[],
    allowed = true,
  ): Type<CanActivate> => {
    @Injectable()
    class RecordingGuard implements CanActivate {
      canActivate() {
        calls.push(name);
        return allowed;
      }
    }
    return RecordingGuard;
  };

  const createRequestScopedGuardClass = (
    name: string,
    calls: string[],
    allowed = true,
  ): Type<CanActivate> => {
    @Injectable({ scope: Scope.REQUEST })
    class RequestScopedRecordingGuard implements CanActivate {
      canActivate() {
        calls.push(name);
        return allowed;
      }
    }
    return RequestScopedRecordingGuard;
  };

  const createGateway = (message: string): Type<unknown> => {
    @WebSocketGateway()
    class MessageGateway {
      @SubscribeMessage(message)
      handle() {
        return message;
      }
    }
    return MessageGateway;
  };

  const connectGateways = async (...guardedAndOpenModules: Type<unknown>[]) => {
    @Module({ imports: guardedAndOpenModules })
    class AppModule {}

    const adapter = new HandlerCapturingAdapter();
    const app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    app.useWebSocketAdapter(adapter);
    try {
      await app.init();
    } catch (error) {
      await app.close();
      throw error;
    }
    adapter.connectClient();
    return { app, adapter };
  };

  it('should guard only the gateways of the declaring module', async () => {
    const calls: string[] = [];
    @Module({
      providers: [
        createGateway('guarded'),
        {
          provide: MODULE_GUARD,
          useClass: createGuardClass('module', calls),
        },
      ],
    })
    class GuardedModule {}

    @Module({ providers: [createGateway('open')] })
    class OpenModule {}

    const { app, adapter } = await connectGateways(GuardedModule, OpenModule);
    try {
      await expect(adapter.handle('open')).resolves.toBe('open');
      expect(calls).toEqual([]);
      await expect(adapter.handle('guarded')).resolves.toBe('guarded');
      expect(calls).toEqual(['module']);
    } finally {
      await app.close();
    }
  });

  it('should reject messages when the module guard denies them', async () => {
    const calls: string[] = [];
    @Module({
      providers: [
        createGateway('guarded'),
        {
          provide: MODULE_GUARD,
          useClass: createGuardClass('module', calls, false),
        },
      ],
    })
    class GuardedModule {}

    const { app, adapter } = await connectGateways(GuardedModule);
    try {
      await adapter.handle('guarded');
      expect(adapter.emittedToClient).toEqual([
        ['exception', expect.objectContaining({ status: 'error' })],
      ]);
    } finally {
      await app.close();
    }
  });

  describe('with a request scoped guard', () => {
    const callsWhenGuardIsProvidedBy = async (token: string) => {
      const calls: string[] = [];
      @Module({
        providers: [
          createGateway('guarded'),
          {
            provide: token,
            useClass: createRequestScopedGuardClass('guard', calls, false),
          },
        ],
      })
      class GuardedModule {}

      const { app, adapter } = await connectGateways(GuardedModule);
      try {
        await adapter.handle('guarded');
      } finally {
        await app.close();
      }
      return calls;
    };

    // Gateways resolve guards in the static context, so APP_GUARD never runs a
    // request scoped guard here; MODULE_GUARD must not diverge from that.
    it('should behave exactly like APP_GUARD does', async () => {
      expect(await callsWhenGuardIsProvidedBy(MODULE_GUARD)).toEqual(
        await callsWhenGuardIsProvidedBy(APP_GUARD),
      );
    });
  });
});
