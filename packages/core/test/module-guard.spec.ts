import {
  CanActivate,
  Controller,
  DynamicModule,
  ForbiddenException,
  Get,
  Global,
  Inject,
  INestApplication,
  Injectable,
  Module,
  Scope,
  Type,
  UseGuards,
} from '@nestjs/common';
import {
  APP_GUARD,
  ExternalContextCreator,
  MODULE_GUARD,
  REQUEST,
} from '@nestjs/core';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import request from 'supertest';

describe('MODULE_GUARD', () => {
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

  const createController = (path: string): Type<unknown> => {
    @Controller(path)
    class PathController {
      @Get()
      find() {
        return path;
      }
    }
    return PathController;
  };

  const withApp = async (
    builder: TestingModuleBuilder,
    scenario: (app: INestApplication) => Promise<void>,
  ) => {
    const app = (await builder.compile()).createNestApplication();
    await app.init();
    try {
      await scenario(app);
    } finally {
      await app.close();
    }
  };

  describe('when a module declares a guard that denies every request', () => {
    it('should reject its own controllers and leave other modules open', async () => {
      const calls: string[] = [];
      @Module({
        controllers: [createController('mcp')],
      })
      class McpModule {}

      @Module({
        controllers: [createController('users')],
        providers: [
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('auth', calls, false),
          },
        ],
      })
      class AuthModule {}

      @Module({ imports: [AuthModule, McpModule] })
      class AppModule {}

      await withApp(
        Test.createTestingModule({ imports: [AppModule] }),
        async app => {
          await request(app.getHttpServer()).get('/users').expect(403);
          await request(app.getHttpServer()).get('/mcp').expect(200);
          expect(calls).toEqual(['auth']);
        },
      );
    });
  });

  describe('when app, module, class and method guards are combined', () => {
    it('should run them in that order', async () => {
      const calls: string[] = [];
      @Controller('ordered')
      @UseGuards(createGuardClass('class', calls))
      class OrderedController {
        @Get()
        @UseGuards(createGuardClass('method', calls))
        find() {
          return 'ordered';
        }
      }

      @Module({
        controllers: [OrderedController],
        providers: [
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('module', calls),
          },
        ],
      })
      class FeatureModule {}

      @Module({
        imports: [FeatureModule],
        providers: [
          { provide: APP_GUARD, useClass: createGuardClass('app', calls) },
        ],
      })
      class AppModule {}

      await withApp(
        Test.createTestingModule({ imports: [AppModule] }),
        async app => {
          await request(app.getHttpServer()).get('/ordered').expect(200);
          expect(calls).toEqual(['app', 'module', 'class', 'method']);
        },
      );
    });
  });

  describe('when the module guard is request scoped', () => {
    it('should resolve it per request and only for the declaring module', async () => {
      const urlsSeenByGuard: string[] = [];
      @Injectable({ scope: Scope.REQUEST })
      class RequestScopedGuard implements CanActivate {
        constructor(
          @Inject(REQUEST) private readonly incomingRequest: { url: string },
        ) {}

        canActivate() {
          urlsSeenByGuard.push(this.incomingRequest.url);
          return true;
        }
      }

      @Module({
        controllers: [createController('guarded')],
        providers: [{ provide: MODULE_GUARD, useClass: RequestScopedGuard }],
      })
      class GuardedModule {}

      @Module({ controllers: [createController('open')] })
      class OpenModule {}

      @Module({ imports: [GuardedModule, OpenModule] })
      class AppModule {}

      await withApp(
        Test.createTestingModule({ imports: [AppModule] }),
        async app => {
          await request(app.getHttpServer()).get('/guarded').expect(200);
          await request(app.getHttpServer()).get('/open').expect(200);
          await request(app.getHttpServer()).get('/guarded').expect(200);
          expect(urlsSeenByGuard).toEqual(['/guarded', '/guarded']);
        },
      );
    });
  });

  describe('when the declaring module is global', () => {
    it('should still guard only its own controllers', async () => {
      const calls: string[] = [];
      @Global()
      @Module({
        controllers: [createController('global-module')],
        providers: [
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('global-module', calls),
          },
        ],
      })
      class GlobalGuardedModule {}

      @Module({ controllers: [createController('other')] })
      class OtherModule {}

      @Module({ imports: [GlobalGuardedModule, OtherModule] })
      class AppModule {}

      await withApp(
        Test.createTestingModule({ imports: [AppModule] }),
        async app => {
          await request(app.getHttpServer()).get('/other').expect(200);
          expect(calls).toEqual([]);
          await request(app.getHttpServer()).get('/global-module').expect(200);
          expect(calls).toEqual(['global-module']);
        },
      );
    });
  });

  describe('when the declaring module is dynamic', () => {
    it('should guard only the controllers of each registered instance', async () => {
      const calls: string[] = [];
      @Module({})
      class FeatureModule {
        static register(path: string, allowed: boolean): DynamicModule {
          return {
            module: FeatureModule,
            controllers: [createController(path)],
            providers: [
              {
                provide: MODULE_GUARD,
                useClass: createGuardClass(path, calls, allowed),
              },
            ],
          };
        }
      }

      @Module({
        imports: [
          FeatureModule.register('allowed', true),
          FeatureModule.register('denied', false),
        ],
      })
      class AppModule {}

      await withApp(
        Test.createTestingModule({ imports: [AppModule] }),
        async app => {
          await request(app.getHttpServer()).get('/allowed').expect(200);
          await request(app.getHttpServer()).get('/denied').expect(403);
          expect(calls).toEqual(['allowed', 'denied']);
        },
      );
    });
  });

  describe('when a module declares several guards', () => {
    it('should run them in declaration order', async () => {
      const calls: string[] = [];
      @Module({
        controllers: [createController('feature')],
        providers: [
          { provide: MODULE_GUARD, useClass: createGuardClass('first', calls) },
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('second', calls),
          },
        ],
      })
      class FeatureModule {}

      await withApp(
        Test.createTestingModule({ imports: [FeatureModule] }),
        async app => {
          await request(app.getHttpServer()).get('/feature').expect(200);
          expect(calls).toEqual(['first', 'second']);
        },
      );
    });
  });

  describe('when the module guard is provided with a factory or a value', () => {
    it('should apply both to the declaring module', async () => {
      const calls: string[] = [];
      const valueGuard: CanActivate = {
        canActivate: () => {
          calls.push('value');
          return true;
        },
      };
      @Module({
        controllers: [createController('feature')],
        providers: [
          { provide: MODULE_GUARD, useValue: valueGuard },
          {
            provide: MODULE_GUARD,
            useFactory: (): CanActivate => ({
              canActivate: () => {
                calls.push('factory');
                return true;
              },
            }),
          },
        ],
      })
      class FeatureModule {}

      await withApp(
        Test.createTestingModule({ imports: [FeatureModule] }),
        async app => {
          await request(app.getHttpServer()).get('/feature').expect(200);
          expect(calls).toEqual(['value', 'factory']);
        },
      );
    });
  });

  describe('when overriding the guard in a test', () => {
    const overridingGuard = (calls: string[]): CanActivate => ({
      canActivate: () => {
        calls.push('replacement');
        return true;
      },
    });
    const callsWhenOverridingGuardProvidedBy = async (token: string) => {
      const calls: string[] = [];
      const OriginalGuard = createGuardClass('original', calls);
      @Module({
        controllers: [createController('feature')],
        providers: [{ provide: token, useClass: OriginalGuard }],
      })
      class FeatureModule {}

      await withApp(
        Test.createTestingModule({ imports: [FeatureModule] })
          .overrideGuard(OriginalGuard)
          .useValue(overridingGuard(calls)),
        async app => {
          await request(app.getHttpServer()).get('/feature').expect(200);
        },
      );
      return calls;
    };
    it('should replace a guard exposed through useExisting with overrideProvider', async () => {
      const calls: string[] = [];
      const Original = createGuardClass('original', calls);
      @Module({
        controllers: [createController('feature')],
        providers: [Original, { provide: MODULE_GUARD, useExisting: Original }],
      })
      class FeatureModule {}

      await withApp(
        Test.createTestingModule({ imports: [FeatureModule] })
          .overrideProvider(Original)
          .useValue(overridingGuard(calls)),
        async app => {
          await request(app.getHttpServer()).get('/feature').expect(200);
          expect(calls).toEqual(['replacement']);
        },
      );
    });
    // overrideGuard cannot reach guards registered through enhancer tokens, so
    // MODULE_GUARD must inherit the APP_GUARD limitation instead of diverging.
    it('should treat overrideGuard on a useClass guard exactly like APP_GUARD does', async () => {
      expect(await callsWhenOverridingGuardProvidedBy(MODULE_GUARD)).toEqual(
        await callsWhenOverridingGuardProvidedBy(APP_GUARD),
      );
    });
  });

  describe('when handlers run through the ExternalContextCreator', () => {
    const withExternalHandler = async (
      declaringModule: Type<unknown>,
      handlerHost: Type<{ handle(): string }>,
      scenario: (handler: () => Promise<unknown>) => Promise<void>,
    ) => {
      const moduleRef = await Test.createTestingModule({
        imports: [declaringModule],
      }).compile();
      try {
        const host = moduleRef.get(handlerHost, { strict: false });
        await scenario(
          moduleRef
            .get(ExternalContextCreator)
            .create(host, host.handle, 'handle'),
        );
      } finally {
        await moduleRef.close();
      }
    };

    it('should guard a provider of the declaring module', async () => {
      const calls: string[] = [];
      @Injectable()
      class Resolver {
        handle() {
          return 'resolved';
        }
      }
      @Module({
        providers: [
          Resolver,
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('module', calls, false),
          },
        ],
      })
      class GuardedModule {}

      await withExternalHandler(GuardedModule, Resolver, async handler => {
        await expect(handler()).rejects.toBeInstanceOf(ForbiddenException);
        expect(calls).toEqual(['module']);
      });
    });
    it('should not guard a controller because it is not found among the providers of any module', async () => {
      const calls: string[] = [];
      @Controller('external')
      class ExternalController {
        handle() {
          return 'handled';
        }
      }
      @Module({
        controllers: [ExternalController],
        providers: [
          {
            provide: MODULE_GUARD,
            useClass: createGuardClass('module', calls, false),
          },
        ],
      })
      class GuardedModule {}

      await withExternalHandler(
        GuardedModule,
        ExternalController,
        async handler => {
          await expect(handler()).resolves.toBe('handled');
          expect(calls).toEqual([]);
        },
      );
    });
  });
});
