import { ContextCreator } from '../../helpers/context-creator.js';

class RecordingContextCreator extends ContextCreator {
  public createConcreteContext = vi.fn().mockReturnValue([]);
}

describe('ContextCreator', () => {
  describe('getModuleMetadata', () => {
    it('should default to no module metadata', () => {
      expect(new RecordingContextCreator().getModuleMetadata()).toEqual([]);
    });
  });

  describe('createContext', () => {
    it('should create the global, module, class and method steps in order', () => {
      const key = 'metadata';
      const callback = () => undefined;
      const instance = {};
      Reflect.defineMetadata(key, ['class'], Object);
      Reflect.defineMetadata(key, ['method'], callback);
      const creator = new RecordingContextCreator();

      creator.createContext(instance, callback, key);

      expect(
        creator.createConcreteContext.mock.calls.map(([metadata]) => metadata),
      ).toEqual([[], [], ['class'], ['method']]);
    });
  });
});
