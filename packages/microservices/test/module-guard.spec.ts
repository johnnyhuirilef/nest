import {
  CanActivate,
  Controller,
  Injectable,
  Module,
  Scope,
  type Type,
} from '@nestjs/common';
import { APP_GUARD, MODULE_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { lastValueFrom, from } from 'rxjs';
import { BaseRpcContext } from '../ctx-host/base-rpc.context.js';
import { EventPattern, MessagePattern } from '../decorators/index.js';
import { CustomTransportStrategy } from '../interfaces/index.js';
import { Server } from '../server/server.js';

describe('MODULE_GUARD with microservice handlers', () => {
  class HandlerCapturingServer
    extends Server
    implements CustomTransportStrategy
  {
    public readonly transportId = Symbol('handler-capturing');

    public on<
      EventKey extends string = string,
      EventCallback extends Function = Function,
    >(_event: EventKey, _callback: EventCallback) {}
    public unwrap<T>(): T {
      throw new Error('The capturing server has no underlying server');
    }
    public listen(callback: () => void) {
      callback();
    }
    public close() {}

    public async handle(pattern: string) {
      const handler = this.getHandlers().get(pattern);
      if (!handler) {
        throw new Error(`No handler was registered for "${pattern}"`);
      }
      return lastValueFrom(
        from(await handler('payload', new BaseRpcContext([]))),
      );
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

  const createHandlersController = (
    messagePattern: string,
    eventPattern: string,
  ): Type<unknown> => {
    @Controller()
    class HandlersController {
      @MessagePattern(messagePattern)
      reply() {
        return messagePattern;
      }

      @EventPattern(eventPattern)
      notify() {
        return eventPattern;
      }
    }
    return HandlersController;
  };

  describe('in a standalone microservice', () => {
    const startMicroservice = async (...modules: Type<unknown>[]) => {
      @Module({ imports: modules })
      class AppModule {}

      const server = new HandlerCapturingServer();
      const microservice = (
        await Test.createTestingModule({ imports: [AppModule] }).compile()
      ).createNestMicroservice({ strategy: server });
      try {
        await microservice.init();
      } catch (error) {
        await microservice.close();
        throw error;
      }
      return { server, microservice };
    };

    it('should guard message and event handlers of the declaring module only', async () => {
      const calls: string[] = [];
      @Module({
        controllers: [
          createHandlersController('guarded-message', 'guarded-event'),
        ],
        providers: [
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('module', calls),
          },
        ],
      })
      class GuardedModule {}

      @Module({
        controllers: [createHandlersController('open-message', 'open-event')],
      })
      class OpenModule {}

      const { server, microservice } = await startMicroservice(
        GuardedModule,
        OpenModule,
      );
      try {
        await server.handle('open-message');
        await server.handle('open-event');
        expect(calls).toEqual([]);

        await server.handle('guarded-message');
        await server.handle('guarded-event');
        expect(calls).toEqual(['module', 'module']);
      } finally {
        await microservice.close();
      }
    });

    it('should reject a message handler when the module guard denies it', async () => {
      const calls: string[] = [];
      @Module({
        controllers: [
          createHandlersController('guarded-message', 'guarded-event'),
        ],
        providers: [
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('module', calls, false),
          },
        ],
      })
      class GuardedModule {}

      const { server, microservice } = await startMicroservice(GuardedModule);
      try {
        await expect(server.handle('guarded-message')).rejects.toMatchObject({
          message: 'Forbidden resource',
        });
      } finally {
        await microservice.close();
      }
    });
  });

  describe('with a request scoped module guard', () => {
    const startGuardedMicroservice = async (guard: Type<CanActivate>) => {
      @Module({
        controllers: [
          createHandlersController('guarded-message', 'guarded-event'),
        ],
        providers: [{ provide: MODULE_GUARD, useClass: guard }],
      })
      class GuardedModule {}

      const server = new HandlerCapturingServer();
      const microservice = (
        await Test.createTestingModule({
          imports: [GuardedModule],
        }).compile()
      ).createNestMicroservice({ strategy: server });
      try {
        await microservice.init();
      } catch (error) {
        await microservice.close();
        throw error;
      }
      return { server, microservice };
    };

    it('should run the guard once per handled message', async () => {
      const calls: string[] = [];
      const { server, microservice } = await startGuardedMicroservice(
        createRequestScopedGuardClass('module', calls),
      );
      try {
        await server.handle('guarded-message');
        expect(calls).toEqual(['module']);
      } finally {
        await microservice.close();
      }
    });

    it('should reject a message handler when the guard denies it', async () => {
      const { server, microservice } = await startGuardedMicroservice(
        createRequestScopedGuardClass('module', [], false),
      );
      try {
        await expect(server.handle('guarded-message')).rejects.toMatchObject({
          message: 'Forbidden resource',
        });
      } finally {
        await microservice.close();
      }
    });
  });

  describe('in a hybrid application', () => {
    const callsWhenGuardIsProvidedBy = async (
      token: string,
      inheritAppConfig: boolean,
    ) => {
      const calls: string[] = [];
      @Module({
        controllers: [createHandlersController('message', 'event')],
        providers: [
          { provide: token, useClass: createGuardClass('guard', calls) },
        ],
      })
      class GuardedModule {}

      const server = new HandlerCapturingServer();
      const app = (
        await Test.createTestingModule({
          imports: [GuardedModule],
        }).compile()
      ).createNestApplication();
      app.connectMicroservice({ strategy: server }, { inheritAppConfig });
      try {
        await app.startAllMicroservices();
        await server.handle('message');
      } finally {
        await app.close();
      }
      return calls;
    };

    it('should run the guard when the microservice inherits the app config, like APP_GUARD', async () => {
      expect(await callsWhenGuardIsProvidedBy(APP_GUARD, true)).toEqual([
        'guard',
      ]);
      expect(await callsWhenGuardIsProvidedBy(MODULE_GUARD, true)).toEqual([
        'guard',
      ]);
    });

    it('should not run the guard when the microservice does not inherit the app config, like APP_GUARD', async () => {
      expect(await callsWhenGuardIsProvidedBy(APP_GUARD, false)).toEqual([]);
      expect(await callsWhenGuardIsProvidedBy(MODULE_GUARD, false)).toEqual([]);
    });
  });
});
