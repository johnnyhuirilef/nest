import { CanActivate, UseGuards } from '@nestjs/common';
import { ApplicationConfig } from '../../application-config.js';
import { GuardsContextCreator } from '../../guards/guards-context-creator.js';
import { STATIC_CONTEXT } from '../../injector/constants.js';
import { InstanceWrapper } from '../../injector/instance-wrapper.js';

class Guard {}

describe('GuardsContextCreator', () => {
  let guardsContextCreator: GuardsContextCreator;
  let applicationConfig: ApplicationConfig;
  let guards: any[];
  let container: any;
  let getSpy: ReturnType<typeof vi.fn>;

  class Guard1 {}
  class Guard2 {}

  beforeEach(() => {
    guards = [
      {
        name: 'Guard1',
        token: Guard1,
        metatype: Guard1,
        instance: {
          canActivate: () => true,
        },
        getInstanceByContextId: () => guards[0],
      },
      {
        name: 'Guard2',
        token: Guard2,
        metatype: Guard2,
        instance: {
          canActivate: () => true,
        },
        getInstanceByContextId: () => guards[1],
      },
      {},
      undefined,
    ];
    getSpy = vi.fn().mockReturnValue({
      injectables: new Map([
        [Guard1, guards[0]],
        [Guard2, guards[1]],
      ]),
    });
    container = {
      getModules: () => ({
        get: getSpy,
      }),
    };
    applicationConfig = new ApplicationConfig();
    guardsContextCreator = new GuardsContextCreator(
      container,
      applicationConfig,
    );
  });
  describe('createConcreteContext', () => {
    describe('when `moduleContext` is nil', () => {
      it('should return empty array', () => {
        const result = guardsContextCreator.createConcreteContext(guards);
        expect(result).toHaveLength(0);
      });
    });
    describe('when `moduleContext` is defined', () => {
      beforeEach(() => {
        guardsContextCreator['moduleContext'] = 'test';
      });
      it('should filter metatypes', () => {
        const guardTypeRefs = [guards[0].metatype, guards[1].instance];
        expect(
          guardsContextCreator.createConcreteContext(guardTypeRefs),
        ).toHaveLength(2);
      });
    });
  });

  describe('getGuardInstance', () => {
    describe('when param is an object', () => {
      it('should return instance', () => {
        const instance = { canActivate: () => null! };
        expect(guardsContextCreator.getGuardInstance(instance)).toEqual(
          instance,
        );
      });
    });
    describe('when param is a constructor', () => {
      it('should pick instance from container', () => {
        const wrapper = {
          instance: 'test',
          getInstanceByContextId: () => wrapper,
        };
        vi.spyOn(
          guardsContextCreator,
          'getInstanceByMetatype',
        ).mockImplementation(() => wrapper as any);
        expect(guardsContextCreator.getGuardInstance(Guard)).toEqual(
          wrapper.instance,
        );
      });
      it('should return null', () => {
        vi.spyOn(
          guardsContextCreator,
          'getInstanceByMetatype',
        ).mockImplementation(() => null!);
        expect(guardsContextCreator.getGuardInstance(Guard)).toEqual(null);
      });
    });
  });

  describe('getInstanceByMetatype', () => {
    describe('when "moduleContext" is nil', () => {
      it('should return undefined', () => {
        (guardsContextCreator as any).moduleContext = undefined;
        expect(
          guardsContextCreator.getInstanceByMetatype(null!),
        ).toBeUndefined();
      });
    });
    describe('when "moduleContext" is not nil', () => {
      beforeEach(() => {
        (guardsContextCreator as any).moduleContext = 'test';
      });

      describe('but module does not exist', () => {
        it('should return undefined', () => {
          expect(
            guardsContextCreator.getInstanceByMetatype(class RandomModule {}),
          ).toBeUndefined();
        });
      });
    });
  });

  describe('getGlobalMetadata', () => {
    describe('when contextId is static and inquirerId is nil', () => {
      it('should return global guards', () => {
        const expectedResult = applicationConfig.getGlobalGuards();
        expect(guardsContextCreator.getGlobalMetadata()).toBe(expectedResult);
      });
    });
    describe('otherwise', () => {
      it('should merge static global with request/transient scoped guards', () => {
        const globalGuards: any = ['test'];
        const instanceWrapper = new InstanceWrapper();
        const instance = 'request-scoped';
        const scopedGuardWrappers = [instanceWrapper];

        vi.spyOn(applicationConfig, 'getGlobalGuards').mockImplementation(
          () => globalGuards,
        );
        vi.spyOn(
          applicationConfig,
          'getGlobalRequestGuards',
        ).mockImplementation(() => scopedGuardWrappers);
        vi.spyOn(instanceWrapper, 'getInstanceByContextId').mockImplementation(
          () => ({ instance }) as any,
        );

        expect(guardsContextCreator.getGlobalMetadata({ id: 3 })).toEqual(
          expect.arrayContaining([instance, ...globalGuards]),
        );
      });
    });
    describe('when contextId is static and inquirerId is defined', () => {
      it('should resolve request scoped guards for the inquirer', () => {
        const instanceWrapper = new InstanceWrapper<CanActivate>();
        const scopedGuard = { canActivate: () => true };
        vi.spyOn(applicationConfig, 'getGlobalRequestGuards').mockReturnValue([
          instanceWrapper,
        ]);
        vi.spyOn(instanceWrapper, 'getInstanceByContextId').mockReturnValue({
          instance: scopedGuard,
        });

        expect(
          guardsContextCreator.getGlobalMetadata(STATIC_CONTEXT, 'inquirer'),
        ).toEqual([scopedGuard]);
        expect(instanceWrapper.getInstanceByContextId).toHaveBeenCalledWith(
          STATIC_CONTEXT,
          'inquirer',
        );
      });
    });
  });

  describe('module guards', () => {
    const moduleKey = 'moduleKey';
    const guardNamed = (name: string): CanActivate & { name: string } => ({
      name,
      canActivate: () => true,
    });
    const requestScopedWrapper = (guard: CanActivate) => {
      const wrapper = new InstanceWrapper<CanActivate>();
      vi.spyOn(wrapper, 'getInstanceByContextId').mockReturnValue({
        instance: guard,
      });
      return wrapper;
    };

    describe('getModuleMetadata', () => {
      it('should return no guards when there is no application config', () => {
        const creatorWithoutConfig = new GuardsContextCreator(container);
        creatorWithoutConfig.create({}, () => undefined, moduleKey);

        expect(creatorWithoutConfig.getModuleMetadata()).toEqual([]);
      });
      it('should return only the guards of the module being created', () => {
        const ownGuard = guardNamed('own');
        applicationConfig.addModuleGuard(moduleKey, ownGuard);
        applicationConfig.addModuleGuard('otherKey', guardNamed('other'));
        guardsContextCreator.create({}, () => undefined, moduleKey);

        expect(guardsContextCreator.getModuleMetadata()).toEqual([ownGuard]);
      });
      it('should merge request scoped guards of the module being created', () => {
        const staticGuard = guardNamed('static');
        const scopedGuard = guardNamed('scoped');
        applicationConfig.addModuleGuard(moduleKey, staticGuard);
        applicationConfig.addModuleRequestGuard(
          moduleKey,
          requestScopedWrapper(scopedGuard),
        );
        applicationConfig.addModuleRequestGuard(
          'otherKey',
          requestScopedWrapper(guardNamed('otherScoped')),
        );
        guardsContextCreator.create({}, () => undefined, moduleKey);

        expect(guardsContextCreator.getModuleMetadata({ id: 3 })).toEqual([
          staticGuard,
          scopedGuard,
        ]);
      });
      it('should resolve request scoped guards for the inquirer and the parent context', () => {
        const wrapper = requestScopedWrapper(guardNamed('scoped'));
        const parentContextId = { id: 7 };
        const contextId = { id: 3, getParent: () => parentContextId };
        applicationConfig.addModuleRequestGuard(moduleKey, wrapper);
        guardsContextCreator.create({}, () => undefined, moduleKey);

        guardsContextCreator.getModuleMetadata(contextId, 'inquirer');

        expect(wrapper.getInstanceByContextId).toHaveBeenCalledWith(
          parentContextId,
          'inquirer',
        );
      });
      it('should merge request scoped guards for an inquirer in the static context', () => {
        const staticGuard = guardNamed('static');
        const scopedGuard = guardNamed('scoped');
        applicationConfig.addModuleGuard(moduleKey, staticGuard);
        applicationConfig.addModuleRequestGuard(
          moduleKey,
          requestScopedWrapper(scopedGuard),
        );
        guardsContextCreator.create({}, () => undefined, moduleKey);

        expect(
          guardsContextCreator.getModuleMetadata(STATIC_CONTEXT, 'inquirer'),
        ).toEqual([staticGuard, scopedGuard]);
      });
      it('should not resolve request scoped guards in the static context', () => {
        const wrapper = requestScopedWrapper(guardNamed('scoped'));
        applicationConfig.addModuleRequestGuard(moduleKey, wrapper);
        guardsContextCreator.create({}, () => undefined, moduleKey);

        expect(guardsContextCreator.getModuleMetadata()).toEqual([]);
        expect(wrapper.getInstanceByContextId).not.toHaveBeenCalled();
      });
    });

    describe('create', () => {
      it('should order guards as global, module, class and method', () => {
        const globalGuard = guardNamed('global');
        const moduleGuard = guardNamed('module');
        const classGuard = guardNamed('class');
        const methodGuard = guardNamed('method');
        applicationConfig.addGlobalGuard(globalGuard);
        applicationConfig.addModuleGuard(moduleKey, moduleGuard);

        @UseGuards(classGuard)
        class TestController {
          @UseGuards(methodGuard)
          handle() {}
        }
        const controller = new TestController();

        expect(
          guardsContextCreator.create(controller, controller.handle, moduleKey),
        ).toEqual([globalGuard, moduleGuard, classGuard, methodGuard]);
      });
      it('should forward the inquirer and the parent context to request scoped module guards', () => {
        const wrapper = requestScopedWrapper(guardNamed('scoped'));
        const parentContextId = { id: 7 };
        const contextId = { id: 3, getParent: () => parentContextId };
        applicationConfig.addModuleRequestGuard(moduleKey, wrapper);

        guardsContextCreator.create(
          {},
          () => undefined,
          moduleKey,
          contextId,
          'inquirer',
        );

        expect(wrapper.getInstanceByContextId).toHaveBeenCalledWith(
          parentContextId,
          'inquirer',
        );
      });
      it('should not apply guards of another module', () => {
        applicationConfig.addModuleGuard('otherKey', guardNamed('other'));

        expect(
          guardsContextCreator.create({}, () => undefined, moduleKey),
        ).toEqual([]);
      });
    });
  });
});
