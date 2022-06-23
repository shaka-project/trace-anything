/**
 * Copyright 2021 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @fileoverview Shim and trace calls to absolutely anything.
 *
 * Requires support for ES classes, ES Map, rest parameters, the spread
 * operator, and template strings.  This should work in all modern browsers
 * (all browsers whose names do not rhyme with Splinter-Wet Deplorer).
 */

/**
 * Shim and trace calls to absolutely anything.
 */
class TraceAnything {
  /**
   * Trace all instances of a certain class.  If the constructor is usable
   * directly, you must overwrite the original constructor with the return
   * value.  Otherwise, you can ignore the return value and TraceAnything will
   * recognize and trace instances of this class that are returned from other
   * traced methods.
   *
   * @param {function} ctor A constructor whose instances you want to trace.
   * @param {TraceAnything.Options} options
   * @return {function} A replacement constructor whose instances will have
   *   their properties, methods, and/or events traced.  options.inPlace has no
   *   effect here.
   */
  static traceClass(ctor, options) {
    options = Object.assign({}, TraceAnything.defaultOptions, options);

    TraceAnything._shimmedClasses.set(ctor, options);

    return function(...args) {
      const className = ctor.name;
      const log = {
        timestamp: Date.now(),
        type: TraceAnything.LogTypes.Constructor,
        className,
        args,
      };

      try {
        const original = new ctor(...args);
        const traced = TraceAnything.traceObject(original, options);

        log.instance = traced;
        log.instanceId = TraceAnything._getId(traced, className, options);
        log.result = original;
        log.duration = Date.now() - log.timestamp;
        options.logger(log);

        return traced;
      } catch (error) {
        log.threw = error;
        log.duration = Date.now() - log.timestamp;
        options.logger(log);
        throw error;
      }
    };
  }

  /**
   * Trace all properties, methods, and/or events (depending on options) of a
   * single object.
   *
   * @param {!Object} object The object you would like to trace.
   * @param {TraceAnything.Options} options
   * @return {!Object} A replacement object whose properties, methods, and/or
   *   events will be traced.  If options.inPlace is true, "object" will be
   *   modified in-place and returned.
   */
  static traceObject(object, options) {
    options = Object.assign({}, TraceAnything.defaultOptions, options);

    if (object.__TraceAnything__) {
      // We're already tracing this!
      return object;
    }

    const ctor = Object.getPrototypeOf(object).constructor;
    const className = ctor.name;
    const traced = options.inPlace ? object : {};

    // A list of all property names.
    const allProperties = [];

    // Shim all enumerable members.
    for (const k in object) {
      if (!options.skipProperties.includes(k)) {
        allProperties.push(k);
      }
    }

    // Shim any "extra" properties, such as non-enumerable ones we wouldn't
    // find in the loop above, or non-standard properties which the caller
    // expects to be tacked on later.
    for (const k of options.extraProperties) {
      allProperties.push(k);
    }

    for (const k of allProperties) {
      // TODO: This "on" discovery mechanism can cover up non-event properties
      // that start with "on", such as Navigator.onLine.
      if (k.startsWith('on') && options.events) {
        // If we shim event listeners separately, ignore this event listener
        // property at this stage.
        continue;
      }

      TraceAnything._shimMember(traced, object, k, className, options);
    }

    traced.__TraceAnythingEvents__ = new Set();

    if (options.events) {
      // Shim any "on" event listener properties.
      for (const k of allProperties.filter((k) => k.startsWith('on'))) {
        TraceAnything._shimEventListenerProperty(
            traced, object, k, className, options);
      }

      // If there's an addEventListener method, we will use that to discover
      // events the app is listening for that may not have a corresponding "on"
      // property.
      if (object.addEventListener) {
        TraceAnything._shimEventListenersDynamically(
            traced, object, className, options);
      }
    }

    // Add explicit event listeners for these events.  This allows tracing of
    // non-discoverable events which have no equivalent "on" property and may
    // not be used by the application.  This also allows the user to request
    // certain explicit events without tracing all events.
    for (const eventName in options.extraEvents) {
      // Since we may be shimming addEventListener, add this event to the set
      // before setting the listener.
      traced.__TraceAnythingEvents__.add(eventName);

      const listener = TraceAnything._shimEventListener(
          object, () => {}, className, eventName, options);
      traced.addEventListener(eventName, listener);
    }

    // Make the traced type an instance of the original type, so instanceof
    // checks will still pass in the application.
    Object.setPrototypeOf(traced, ctor.prototype);
    console.assert(traced instanceof ctor);

    // Make sure we can tell later what is shimmed already.
    traced.__TraceAnything__ = true;

    // We ignore the return value, but this has the side-effect of setting the
    // generated ID on "traced".  This call ensures that when we log this
    // object as a return value, its ID will show up in the logs and can be
    // correlated to later calls where it is the instance on which methods or
    // events are logged.  Also, this is done after all the shims are
    // installed, so that we don't shim the auto-generated ID property.
    TraceAnything._getId(traced, className, options);

    return traced;
  }

  /**
   * Trace a single member (method or property) of a single object.
   *
   * @param {!Object} object The object you would like to trace.
   * @param {string} name The name of the member you would like to trace.
   * @param {TraceAnything.Options} options
   * @return {?} A replacement member which will be traced.  If options.inPlace
   *   is true, "object" will be modified in-place to replace the original
   *   member.
   */
  static traceMember(object, name, options) {
    options = Object.assign({}, TraceAnything.defaultOptions, options);

    const ctor = Object.getPrototypeOf(object).constructor;
    const traced = options.inPlace ? object : {};
    TraceAnything._shimMember(traced, object, name, ctor.name, options);
    return traced[name];
  }

  /**
   * Trace a single member (method or property) of a class's prototype.
   *
   * @param {function} ctor A constructor whose instances you want to trace.
   * @param {string} name The name of the member you would like to trace.
   * @param {TraceAnything.Options} options
   * @return {?} A replacement member which will be traced.  If options.inPlace
   *   is true, "ctor.prototype" will be modified in-place to replace the
   *   original member.
   */
  static tracePrototype(ctor, name, options) {
    options = Object.assign({}, TraceAnything.defaultOptions, options);

    const traced = options.inPlace ? ctor.prototype : {};
    TraceAnything._shimMember(traced, ctor.prototype, name, ctor.name, options);
    return traced[name];
  }

  /**
   * Trace all instances of a certain element name in the document.  Existing
   * elements will be traced immediately, and the document will be monitored for
   * new elements at runtime.
   *
   * @param {string} name The name of the tag of the elements you want to trace.
   * @param {TraceAnything.Options} options
   */
  static traceElement(name, options) {
    TraceAnything._traceExistingElements(name, options);
    TraceAnything._tracedElementNames.set(name.toLowerCase(), options);
    TraceAnything._setupNewElementObserver();
  }

  /**
   * Scan the document for elements we should be tracing, explicitly, right now.
   * Useful in testing if you don't want to wait for the mutation observer to
   * fire.
   */
  static scanDocumentForNewElements() {
    for (const [name, options] of TraceAnything._tracedElementNames) {
      TraceAnything._traceExistingElements(name, options);
    }
  }

  /**
   * Trace existing elements in the document.
   *
   * @param {string} name The name of the tag of the elements to trace.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _traceExistingElements(name, options) {
    for (const element of document.querySelectorAll(name)) {
      TraceAnything.traceObject(element, options);
    }
  }

  /**
   * Set up an observer to monitor the document for new elements.  If this is
   * run too early in the lifecycle of the page, the effect will be delayed
   * until the page's content is fully loaded.
   */
  static _setupNewElementObserver() {
    if (!document.body) {
      // The document isn't ready yet.  Try again when it is.
      document.addEventListener('DOMContentLoaded', () => {
        TraceAnything.scanDocumentForNewElements();
        TraceAnything._setupNewElementObserver();
      });
      return;
    }

    // If this is called multiple times before DOMContentLoaded, we could end up
    // with multiple deferred calls occurring later.  Check if we already have
    // an observer, and do nothing if we have one.
    if (TraceAnything._newElementObserver) {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!node.tagName) {
            continue;
          }

          const name = node.tagName.toLowerCase();
          const options = TraceAnything._tracedElementNames.get(name);

          if (options) {
            TraceAnything.traceObject(node, options);
          }
        }
      }
    });

    observer.observe(document.documentElement, { childList: true });
    TraceAnything._newElementObserver = observer;
  }

  /**
   * Shim one member for tracing.
   *
   * @param {!Object} traced The traced object.
   * @param {!Object} object The original object.
   * @param {string} k The member name.
   * @param {string} className The class name.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _shimMember(traced, object, k, className, options) {
    // If we are not supposed to trace a member, we still shim it, or else
    // reading/writing it won't trigger any native getters/setters on the
    // underlying object.  This "silent" shim won't trace the values, but will
    // just delegate to the underlying object.

    if (typeof object[k] == 'function') {
      if (options.methods) {
        TraceAnything._shimMethod(traced, object, k, className, options);
      } else {
        TraceAnything._shimPropertySilent(traced, object, k, options);
      }
    } else if (options.properties && options.treatPromisePropertiesAsEvents &&
               object[k] && object[k].then) {
      TraceAnything._shimPromiseProperty(traced, object, k, className, options);
    } else {
      if (options.properties) {
        TraceAnything._shimProperty(traced, object, k, className, options);
      } else {
        TraceAnything._shimPropertySilent(traced, object, k, options);
      }
    }
  }

  /**
   * Shim one method for tracing.
   *
   * @param {!Object} traced The traced object.
   * @param {!Object} object The original object.
   * @param {string} k The member name.
   * @param {string} className The class name.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _shimMethod(traced, object, k, className, options) {
    const originalMethod = object[k];

    // Set a shim method that logs the arguments and any return values or
    // thrown errors.  If the return value is of a type that we are tracing,
    // we also shim the return value.
    traced[k] = function(...args) {
      const log = {
        timestamp: Date.now(),
        type: TraceAnything.LogTypes.Method,
        instance: this,
        instanceId: TraceAnything._getId(this, className, options),
        className,
        methodName: k,
        args,
      };

      try {
        const returnValue = originalMethod.apply(this, args);
        log.result = returnValue;
        log.duration = Date.now() - log.timestamp;

        if (returnValue == null) {
          // If this is null, it's not a Promise.  Return the value right away.
          options.logger(log);
          return returnValue;
        }

        // We can't shim the types coming out of async methods without waiting
        // on the results.  This check covers both Promises and more general
        // "thenables", of which Promises are one implementation.
        if (returnValue.then) {
          if (options.logAsyncResultsImmediately) {
            options.logger(log);
          }

          const promiseShim = new Promise((resolve, reject) => {
            returnValue.then((asyncValue) => {
              asyncValue = TraceAnything._shimReturnValue(asyncValue, options);

              if (!options.logAsyncResultsImmediately) {
                log.result = asyncValue;
                log.duration = Date.now() - log.timestamp;
                options.logger(log);
              }

              resolve(asyncValue);
            }, (error) => {
              if (!options.logAsyncResultsImmediately) {
                delete log.result;
                log.threw = error;
                log.duration = Date.now() - log.timestamp;
                options.logger(log);
              }

              reject(error);
            });
          });

          return promiseShim;
        } else {
          options.logger(log);
          return TraceAnything._shimReturnValue(returnValue, options);
        }
      } catch (error) {
        delete log.result;
        log.threw = error;
        log.duration = Date.now() - log.timestamp;
        options.logger(log);
        throw error;
      }
    };

    // Make sure we can tell later what is shimmed already.
    traced[k].__TraceAnything__ = true;
  }

  /**
   * Shim a return value.
   *
   * @param {?} returnValue
   * @param {TraceAnything.Options} options
   * @return {?} A traced version of the return value if it is of a type that we
   *   are configured to trace.
   * @private
   */
  static _shimReturnValue(returnValue, options) {
    if (returnValue == null) {
      // This is null or undefined.
      return returnValue;
    }

    if (returnValue.__TraceAnything__) {
      // This is a value we're already tracing.  So return it now.
      return returnValue;
    }

    const returnType = Object.getPrototypeOf(returnValue).constructor;
    const returnTypeOptions = TraceAnything._shimmedClasses.get(returnType);
    if (returnTypeOptions) {
      // The returned value is of a type we are tracing, but we aren't
      // tracing this value yet.  This could happen if the value were
      // constructed natively inside the browser.  To trace it, we return a
      // wrapper to trace the return value.
      return TraceAnything.traceObject(returnValue, returnTypeOptions);
    }

    for (const k of options.exploreResultFields) {
      if (k in returnValue) {
        returnValue[k] = TraceAnything._shimReturnValue(returnValue[k], options);
      }
    }

    // This is a value we aren't tracing and shouldn't be tracing.
    return returnValue;
  }

  /**
   * Shim one property (not a method) for tracing.
   *
   * @param {!Object} traced The traced object.
   * @param {!Object} object The original object.
   * @param {string} k The member name.
   * @param {string} className The class name.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _shimProperty(traced, object, k, className, options) {
    const originalDescriptor = TraceAnything._getDescriptor(object, k);
    console.assert(originalDescriptor != null);

    if (options.inPlace && !originalDescriptor.configurable) {
      options.logger({
        timestamp: Date.now(),
        duration: 0,
        type: TraceAnything.LogTypes.Warning,
        message: `Unable to trace ${k} on ${className} in-place!`,
      });
      return;
    }

    const newDescriptor = {
      configurable: true,
      enumerable: originalDescriptor.enumerable,
    };

    if ('value' in originalDescriptor) {
      // The original had no getter/setter for us to delegate to.  So our
      // getter and setter will store the value in this local variable.  Our
      // setter will log the new value.
      let propertyValue = originalDescriptor.value;

      // Since there was no original getter, the value will only change through
      // the setter.  So we don't log anything from this getter.
      newDescriptor.get = () => propertyValue;

      if (originalDescriptor.writable) {
        newDescriptor.set = (value) => {
          options.logger({
            timestamp: Date.now(),
            duration: 0,
            type: TraceAnything.LogTypes.Setter,
            instance: traced,
            instanceId: TraceAnything._getId(traced, className, options),
            className,
            memberName: k,
            value,
          });
          propertyValue = value;
        };
      }
    } else {
      // Define a property whose getter and setter delegate to the object's
      // original getter and setter. Our setter will log the new value.
      if (originalDescriptor.get) {
        newDescriptor.get = function() {
          const log = {
            timestamp: Date.now(),
            type: TraceAnything.LogTypes.Getter,
            instance: traced,
            instanceId: TraceAnything._getId(traced, className, options),
            className,
            memberName: k,
          };

          try {
            const value = originalDescriptor.get.call(this);
            log.result = value;
            log.duration = Date.now() - log.timestamp;
            options.logger(log);

            return value;
          } catch (error) {
            log.threw = error;
            log.duration = Date.now() - log.timestamp;
            options.logger(log);
            throw error;
          }
        };
      }

      if (originalDescriptor.set) {
        newDescriptor.set = function(value) {
          const log = {
            timestamp: Date.now(),
            type: TraceAnything.LogTypes.Setter,
            instance: traced,
            instanceId: TraceAnything._getId(traced, className, options),
            className,
            memberName: k,
          };

          try {
            originalDescriptor.set.call(this, value);
            log.value = value;
            log.duration = Date.now() - log.timestamp;
            options.logger(log);
          } catch (error) {
            log.threw = error;
            log.duration = Date.now() - log.timestamp;
            options.logger(log);
            throw error;
          }
        };
      }
    }

    Object.defineProperty(traced, k, newDescriptor);
  }

  /**
   * Shim one property that contains a Promise or Promise getter.  When the
   * Promise is resolved, a pseudo-event will be logged.
   *
   * @param {!Object} traced The traced object.
   * @param {!Object} object The original object.
   * @param {string} k The member name.
   * @param {string} className The class name.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _shimPromiseProperty(traced, object, k, className, options) {
    const promise = object[k];
    promise.then((result) => {
      const log = {
        timestamp: Date.now(),
        duration: 0,
        type: TraceAnything.LogTypes.Event,
        instance: traced,
        instanceId: TraceAnything._getId(traced, className, options),
        className,
        eventName: `${k} Promise resolved`,
        event: {
          result,
        },
      };
      options.logger(log);
    }, (error) => {
      const log = {
        timestamp: Date.now(),
        duration: 0,
        type: TraceAnything.LogTypes.Event,
        instance: traced,
        instanceId: TraceAnything._getId(traced, className, options),
        className,
        eventName: `${k} Promise rejected`,
        event: {
          threw: error,
        },
      };
      options.logger(log);
    });
  }

  /**
   * If we are not supposed to trace a member, we still shim it, or else
   * reading/writing it won't trigger any native getters/setters on the
   * underlying object.  This "silent" shim won't trace the values, but will
   * just delegate to the underlying object.
   *
   * @param {!Object} traced The traced object.
   * @param {!Object} object The original object.
   * @param {string} k The member name.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _shimPropertySilent(traced, object, k, options) {
    if (options.inPlace) {
      // If we're shimming the object in-place, we don't need a "silent" shim.
      // That is only needed for constructing a new traced object to take the
      // place of the original.
      return;
    }

    const originalDescriptor = TraceAnything._getDescriptor(object, k);
    console.assert(originalDescriptor != null);

    // Copy the original descriptor, but make it configurable in case another
    // part of the code wants to reconfigure the property.
    const newDescriptor = Object.assign({}, originalDescriptor, {
      configurable: true,
    });

    Object.defineProperty(traced, k, newDescriptor);
  }

  /**
   * Shim an event listener property for tracing.
   *
   * @param {!Object} traced The traced object.
   * @param {!Object} object The original object.
   * @param {string} k The member name.
   * @param {string} className The class name.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _shimEventListenerProperty(traced, object, k, className, options) {
    console.assert(k.startsWith('on'));
    const eventName = k.replace(/^on/, '');

    if (options.skipEvents.includes(eventName)) {
      return;
    }

    traced.__TraceAnythingEvents__.add(eventName);

    const originalDescriptor = TraceAnything._getDescriptor(object, k);
    console.assert(originalDescriptor != null);

    // An event listener property like "onfoo" should almost certainly have a
    // getter and setter for the native code to put the new values into action.
    console.assert(originalDescriptor.get && originalDescriptor.set);

    // Save the old value to be shimmed later.  Note that for an in-place shim,
    // this will be overwritten by our getter/setter later, so we must save it
    // now.
    const oldListener = object[k];

    // Shim any future listeners set through the traced object.
    Object.defineProperty(traced, k, {
      configurable: true,
      enumerable: true,
      get: function() {
        return originalDescriptor.get.call(this);
      },
      set: function(listener) {
        // Because we listen to all events, we don't want to remove the
        // listener completely.  Instead, turn it into a no-op so the shim can
        // still trace the event.
        if (!listener) {
          listener = () => {};
        }

        const shim = TraceAnything._shimEventListener(
            object, listener, className, eventName, options);
        originalDescriptor.set.call(this, shim);
      },
    });

    // Set the old listener again (which may be null or undefined) to shim it
    // right away.
    traced[k] = oldListener;
  }

  /**
   * Add our own event listeners dynamically when the app adds listeners for
   * events we don't know about yet.
   *
   * @param {!Object} traced The traced object.
   * @param {!Object} object The original object.
   * @param {string} className The class name.
   * @param {TraceAnything.Options} options
   * @private
   */
  static _shimEventListenersDynamically(traced, object, className, options) {
    const originalMethod = object.addEventListener;

    // Set a shim method that tracks any newly discovered events and adds
    // listeners for them.
    traced.addEventListener = function(eventName, ...args) {
      if (!traced.__TraceAnythingEvents__.has(eventName) &&
          !options.skipEvents.includes(eventName)) {
        traced.__TraceAnythingEvents__.add(eventName);

        const listener = TraceAnything._shimEventListener(
            traced, () => {}, className, eventName, options);
        originalMethod.call(this, eventName, listener);
      }

      return originalMethod.call(this, eventName, ...args);
    }
  }

  /**
   * Shim an event listener for tracing.
   *
   * @param {!Object} traced The traced object.
   * @param {function} listener The event listener.
   * @param {string} k The member name.
   * @param {string} className The class name.
   * @param {string} eventName The event name.
   * @param {TraceAnything.Options} options
   * @return {function} A shim for the event listener which logs events.
   * @private
   */
  static _shimEventListener(traced, listener, className, eventName, options) {
    // If this event corresponds to a change in a specific property, try to
    // find it now.  Then we can log the specific value it has in the listener.
    let correspondingPropertyName = null;

    if (eventName in options.eventProperties) {
      correspondingPropertyName = options.eventProperties[eventName];
    } else {
      const canonicalEventName = eventName.toLowerCase();
      const lowerCasePropertyName = canonicalEventName.replace(/change$/, '');
      for (const k in traced) {
        if (k.toLowerCase() == lowerCasePropertyName) {
          correspondingPropertyName = k;
          break;
        }
      }
    }

    // Return a shim listener which logs the event.
    return function(event) {
      const log = {
        timestamp: Date.now(),
        duration: 0,
        type: TraceAnything.LogTypes.Event,
        instance: traced,
        instanceId: TraceAnything._getId(traced, className, options),
        className,
        eventName,
        event,
      };

      // The corresponding property may be an array of multiple properties
      // which should be logged with this event.  If so, create an Object
      // mapping names to values.
      if (Array.isArray(correspondingPropertyName)) {
        log.value = {};
        for (const name of correspondingPropertyName) {
          log.value[name] = TraceAnything._extractProperty(traced, name);
        }
      } else if (correspondingPropertyName) {
        log.value = TraceAnything._extractProperty(
            traced, correspondingPropertyName);
      }

      options.logger(log);

      // This supports the EventListener interface, in which "listener" could be
      // an object with a "handleEvent" field.
      if (listener.handleEvent) {
        return listener.handleEvent.call(this, event);
      } else {
        return listener.call(this, event);
      }
    };
  }

  /**
   * Extract a single property value from an object by name.
   *
   * @param {!Object} object The object from which to extract the value.
   * @param {string} name The name of the property.  If the property is a
   *   method, the method will be called to get the value.
   * @return {?} The extracted value, which could be anything.
   * @private
   */
  static _extractProperty(object, name) {
    const value = object[name];

    // If the property is a method, call it now.
    if (value instanceof Function) {
      return value.call(object);
    } else {
      return value;
    }
  }

  /**
   * Find a property descriptor for a particular property of an object.  This
   * allows access to getters and setters.
   *
   * @param {!Object} object The object for which we want to find a property
   *   descriptor.
   * @param {string} k The name of the property.
   * @return {Object} The property descriptor, or null if one cannot be found.
   * @private
   */
  static _getDescriptor(object, k) {
    while (object) {
      const descriptor = Object.getOwnPropertyDescriptor(object, k);
      if (descriptor) {
        return descriptor;
      }

      // Walk the prototype chain and keep looking.
      object = Object.getPrototypeOf(object);
    }
    return null;
  }

  /**
   * @param {!Object} traced The traced object.
   * @param {string} className The class name.
   * @param {TraceAnything.Options} options
   * @return {string} The existing or newly-auto-generated ID for the object.
   * @private
   */
  static _getId(traced, className, options) {
    if (options.idProperty && options.idProperty in traced) {
      return traced[options.idProperty];
    }

    if (traced.__TraceAnythingId__ == null) {
      const id = TraceAnything._nextGeneratedId.get(className) || 1;
      TraceAnything._nextGeneratedId.set(className, id + 1);
      traced.__TraceAnythingId__ = className + '_' + id;
    }
    return traced.__TraceAnythingId__;
  }
}

/**
 * Log type constants sent through the logger.
 *
 * @enum {string}
 */
TraceAnything.LogTypes = {
  Constructor: 'Constructor',
  Method: 'Method',
  Getter: 'Getter',
  Setter: 'Setter',
  Event: 'Event',
  Warning: 'Warning',
};

/**
 * @typedef {{
 *   timestamp: Number,
 *   duration: Number,
 *   type: TraceAnything.LogTypes,
 *   instance: (!Object|undefined),
 *   instanceId: (string|undefined),
 *   message: (string|undefined),
 *   className: (string|undefined),
 *   methodName: (string|undefined),
 *   memberName: (string|undefined),
 *   eventName: (string|undefined),
 *   args: (!Array<?>|undefined),
 *   threw: (?|undefined),
 *   result: (?|undefined),
 *   value: (?|undefined)
 * }}
 * @property {Number} timestamp
 *   A timestamp of when the call was made, in milliseconds since 1970, UTC.
 *   Suitable for use in the Date constructor in JavaScript.
 * @property {Number} duration
 *   The duration of this call in milliseconds.  This is particularly useful
 *   information for async methods.  The value may be 0 for some types, such as
 *   events or warnings.
 * @property {TraceAnything.LogTypes} type
 *   The type of log.
 * @property {(!Object|undefined)} instance
 *   The instance on which this method call / getter / setter / event occurred.
 * @property {(string|undefined)} instanceId
 *   The instance ID.  May be auto-generated for some types.
 *   See TraceAnything.Options.idProperty.
 * @property {(string|undefined)} message
 *   A message for Warning-type logs.
 * @property {(string|undefined)} className
 *   A class name for non-Warning-type logs.
 * @property {(string|undefined)} methodName
 *   A method name for Method-type logs.
 * @property {(string|undefined)} memberName
 *   A member name for Getter- and Setter-type logs.
 * @property {(string|undefined)} eventName
 *   An event name for Event-type logs.
 * @property {(!Array<?>|undefined)} args
 *   An arguments array for Constructor- and Method-type logs.
 * @property {(?|undefined)} threw
 *   What was thrown if the constructor/method/getter/setter threw.
 * @property {(?|undefined)} result
 *   What was returned if the constructor/method/getter did not throw.
 * @property {(?|undefined)} value
 *   The value that was set in a setter, or the object property associated with
 *   an event by its name.  (For example, object.error for an error event, or
 *   object.keyStatuses for a keystatuseschange event.)
 */
TraceAnything.Log;

/**
 * The default logger for TraceAnything.  Everything will be logged to the
 * JavaScript console, and in a rich format where objects can be interrogated
 * further.
 *
 * @param {TraceAnything.Log} log
 */
TraceAnything.defaultLogger = (log) => {
  // NOTE: We are not combining everything into a single string in the default
  // logger, because the JS console is actually capable of printing complex
  // values like objects and arrays.
  let logPrefix = `TraceAnything: (ID ${log.instanceId}) `;

  if (log.type == TraceAnything.LogTypes.Warning) {
    console.warn(logPrefix + log.message);
    return;
  }

  if (log.type == TraceAnything.LogTypes.Constructor) {
    logPrefix += `new ${log.className}`;
  } else if (log.type == TraceAnything.LogTypes.Method) {
    logPrefix += `${log.className}.${log.methodName}`;
  } else if (log.type == TraceAnything.LogTypes.Getter ||
             log.type == TraceAnything.LogTypes.Setter) {
    logPrefix += `${log.className}.${log.memberName}`;
  } else if (log.type == TraceAnything.LogTypes.Event) {
    logPrefix += `${log.className} ${log.eventName} event`;
  }

  if (log.type == TraceAnything.LogTypes.Constructor ||
      log.type == TraceAnything.LogTypes.Method) {
    // For console logging, put a comma between the arguments.
    // NOTE: Since we want to print potentially complex objects in the args
    // array, we don't use join, which results in a single string.
    const argsWithCommas = log.args.reduce((r, a) => r.concat(a, ','), []);
    // Remove a trailing comma from the end of the array.
    argsWithCommas.pop();

    if (log.threw) {
      console.error(`${logPrefix}(`, ...argsWithCommas, ') threw', log.threw);
    } else {
      console.debug(`${logPrefix}(`, ...argsWithCommas, ') =>', log.result);
    }
  } else if (log.type == TraceAnything.LogTypes.Getter) {
    if (log.threw) {
      console.error(`${logPrefix} threw`, log.threw);
    } else {
      console.debug(`${logPrefix} =>`, log.result);
    }
  } else if (log.type == TraceAnything.LogTypes.Setter) {
    if (log.threw) {
      console.error(`${logPrefix} =`, log.value, 'threw', log.threw);
    } else {
      console.debug(`${logPrefix} =`, log.value);
    }
  } else if (log.type == TraceAnything.LogTypes.Event) {
    if ('value' in log) {
      console.debug(logPrefix, log.event, '=>', log.value);
    } else {
      console.debug(logPrefix, log.event);
    }
  }
};

/**
 * @typedef {{
 *   inPlace: boolean,
 *   methods: boolean,
 *   properties: boolean,
 *   treatPromisePropertiesAsEvents: boolean,
 *   extraProperties: !Array<string>,
 *   skipProperties: !Array<string>,
 *   events: boolean,
 *   extraEvents: !Array<string>,
 *   skipEvents: !Array<string>,
 *   exploreResultFields: !Array<string>,
 *   logger: function(TraceAnything.Log),
 *   logAsyncResultsImmediately: boolean
 * }}
 * @property {boolean} inPlace
 *   If true, the shimmed object will be modified in-place.  Not all objects can
 *   be modified in place.
 *   If false, the traceObject and traceMethod methods will return a wrapper
 *   object that you should assign to replace the original.
 *   By default, true.
 * @property {boolean} methods
 *   Shim methods.  Without further configuration, this will shim all enumerable
 *   methods.  extraProperties can be used to list non-enumerable methods to
 *   shim.
 *   By default, true.
 * @property {boolean} properties
 *   Shim properties.  Without futher configuration, this will shim all
 *   enumerable properties.  extraProperties can be used to list non-enumerable
 *   properties to shim.
 *   By default, true.
 * @property {boolean} treatPromisePropertiesAsEvents
 *   If true, any property which is discovered to be a Promise or thenable will
 *   be treated like an event which fires when the Promise is resolved.
 *   By default, true.
 * @property {!Array<string>} extraProperties
 *   Shim these non-enumerable properties/methods we wouldn't be able to find
 *   otherwise, or non-standard properties which the caller expects to be tacked
 *   on later.  Will do nothing without setting methods or properties to true.
 *   By default, empty.
 * @property {!Array<string>} skipProperties
 *   Skip shimming these properties/methods.  This allows certain noisy getters,
 *   setters, or methods to be suppressed, while still tracing events generally.
 *   By default, empty.
 * @property {boolean} events
 *   Shim all events.  Events with "on" properties and events listened to by the
 *   application will be discovered automatically.
 *   By default, true.
 * @property {!Array<string>} extraEvents
 *   Add explicit event listeners for these events.  This allows tracing of
 *   non-discoverable events which have no equivalent "on" property and may not
 *   be used by the application.  This also allows the user to request certain
 *   explicit events without tracing all events.
 *   By default, empty.
 * @property {!Array<string>} skipEvents
 *   Skip event listeners for these events.  This allows certain noisy events
 *   to be suppressed, while still tracing events generally.
 *   By default, empty.
 * @property {!Object<string, (string|!Array<string>)>} eventProperties
 *   A map of event names to their associated properties.  If a property matches
 *   an event name (case-insensitive, with "change" removed from the event
 *   name), its value will be logged with the event automatically.  This
 *   configuration allows values to be associated with an event if the property
 *   name differs from the event name.  An array of property names can also be
 *   used.  If a property name refers to a method, the method will be called and
 *   its return value will be logged.
 *   By default, empty.
 * @property {!Array<string>} exploreResultFields
 *   Explore specific fields of the results of a method.  This allows tracing
 *   into return values that are plain objects.
 *   By default, empty.
 * @property {function(TraceAnything.Log)} logger
 *   A callback that recieves log objects.
 *   By default, TraceAnything.defaultLogger, which logs to the JavaScript
 *   console.
 * @property {boolean} logAsyncResultsImmediately
 *   If true, log the returned Promise from an async method immediately.  This
 *   can be sensible when logging to a JavaScript console, as the live object
 *   can be inspected later when it has a value.  This means that the duration
 *   of a log would only reflect the time spent getting a Promise back from the
 *   method.
 *   If false, wait for the Promise to be resolved or rejected before logging.
 *   This is more useful when logging pure text, since the output becomes
 *   static once logged.  This also makes the duration of a log reflect the time
 *   spent waiting for the Promise to be resolved or rejected.
 *   By default, true.
 * @property {string} idProperty
 *   The name of a property to use to identify instances in the logs.  If null,
 *   or if the associated property does not exist on the object, TraceAnything
 *   will generate an ID automatically.
 *   By default, "id".
 */
TraceAnything.Options;


/**
 * The default options for TraceAnything.  Any option not specified in a call to
 * TraceAnything will be replaced by its default.
 *
 * @type {TraceAnything.Options}
 */
TraceAnything.defaultOptions = {
  inPlace: true,
  methods: true,
  properties: true,
  treatPromisePropertiesAsEvents: true,
  extraProperties: [],
  skipProperties: [],
  events: true,
  extraEvents: [],
  skipEvents: [],
  eventProperties: {},
  exploreResultFields: [],
  logger: TraceAnything.defaultLogger,
  logAsyncResultsImmediately: true,
  idProperty: "id",
};

/**
 * A map of traced class names to the options used for them.
 *
 * @private {!Map<string, TraceAnything.Options>}
 */
TraceAnything._shimmedClasses = new Map();

/**
 * A map of traced HTML element names to the options used for them.
 *
 * @private {!Map<string, TraceAnything.Options>}
 */
TraceAnything._tracedElementNames = new Map();

/**
 * An observer to monitor the document for changes and identify newly-added
 * elements that we should trace.
 *
 * @private {MutationObserver}
 */
TraceAnything._newElementObserver = null;

/**
 * The next ID for objects which need an ID generated for the logs.
 * ID numbers are per-type, and the map is indexed by type name.
 * See also TraceAnything.Options.idProperty and TraceAnything.Log.instanceId.
 *
 * @private {Map<string, number>}
 */
TraceAnything._nextGeneratedId = new Map();

// In a nodejs environment, export the module.  In a browser, don't.
// See https://github.com/google/eme_logger/issues/25
if (typeof module !== 'undefined') {
  module.exports = {TraceAnything};
}
