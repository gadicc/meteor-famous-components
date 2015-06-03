/*
 * Modify Tracker to make sure auto flushing doesn't block famo.us frames
 */

// Based on https://github.com/meteor/meteor/91ce1561c3e94c35685e09b439f02125312bec8e/packages/tracker/tracker.js
// commit 91ce156, released AFTER tracker 1.0.7 and AFTER Meteor v1.1.0.2, 2015-Apr-06

// https://github.com/Famous/famous/blob/729b9754abfa6f2e465c2c5291086eb7c35bc7b6/src/core/Engine.js
// commit 729b9754ab. first released in famo.us v0.3.2
// var MAX_DEFER_FRAME_TIME = 10;

/*
 * First we need to replace all methods with the original code, to gain access
 * to (replace) private variables.  Later in FView.Ready() we'll replace the
 * actual function (at the end of this file).  Before then, only change is to
 * comment out "Tracker = {}" to avoid changing exports.
 */

/////////////////////////////////////////////////////
// Package docs at http://docs.meteor.com/#tracker //
/////////////////////////////////////////////////////

/**
 * @namespace Tracker
 * @summary The namespace for Tracker-related methods.
 */
//Tracker = {};

// http://docs.meteor.com/#tracker_active

/**
 * @summary True if there is a current computation, meaning that dependencies on reactive data sources will be tracked and potentially cause the current computation to be rerun.
 * @locus Client
 * @type {Boolean}
 */
Tracker.active = false;

// http://docs.meteor.com/#tracker_currentcomputation

/**
 * @summary The current computation, or `null` if there isn't one.  The current computation is the [`Tracker.Computation`](#tracker_computation) object created by the innermost active call to `Tracker.autorun`, and it's the computation that gains dependencies when reactive data sources are accessed.
 * @locus Client
 * @type {Tracker.Computation}
 */
Tracker.currentComputation = null;

// References to all computations created within the Tracker by id.
// Keeping these references on an underscore property gives more control to
// tooling and packages extending Tracker without increasing the API surface.
// These can used to monkey-patch computations, their functions, use
// computation ids for tracking, etc.
Tracker._computations = {};

var setCurrentComputation = function (c) {
  Tracker.currentComputation = c;
  Tracker.active = !! c;
};

var _debugFunc = function () {
  // We want this code to work without Meteor, and also without
  // "console" (which is technically non-standard and may be missing
  // on some browser we come across, like it was on IE 7).
  //
  // Lazy evaluation because `Meteor` does not exist right away.(??)
  return (typeof Meteor !== "undefined" ? Meteor._debug :
          ((typeof console !== "undefined") && console.error ?
           function () { console.error.apply(console, arguments); } :
           function () {}));
};

var _maybeSupressMoreLogs = function (messagesLength) {
  // Sometimes when running tests, we intentionally supress logs on expected
  // printed errors. Since the current implementation of _throwOrLog can log
  // multiple separate log messages, supress all of them if at least one supress
  // is expected as we still want them to count as one.
  if (typeof Meteor !== "undefined") {
    // fviews, optional for old meteor releases
    if (Meteor._supressed_log_expected && Meteor._supressed_log_expected()) {
      Meteor._suppress_log(messagesLength - 1);
    }
  }
};

var _throwOrLog = function (from, e) {
  if (throwFirstError) {
    throw e;
  } else {
    var printArgs = ["Exception from Tracker " + from + " function:"];
    if (e.stack && e.message && e.name) {
      var idx = e.stack.indexOf(e.message);
      if (idx < 0 || idx > e.name.length + 2) { // check for "Error: "
        // message is not part of the stack
        var message = e.name + ": " + e.message;
        printArgs.push(message);
      }
    }
    printArgs.push(e.stack);
    _maybeSupressMoreLogs(printArgs.length);

    for (var i = 0; i < printArgs.length; i++) {
      _debugFunc()(printArgs[i]);
    }
  }
};

// Takes a function `f`, and wraps it in a `Meteor._noYieldsAllowed`
// block if we are running on the server. On the client, returns the
// original function (since `Meteor._noYieldsAllowed` is a
// no-op). This has the benefit of not adding an unnecessary stack
// frame on the client.
var withNoYieldsAllowed = function (f) {
  if ((typeof Meteor === 'undefined') || Meteor.isClient) {
    return f;
  } else {
    return function () {
      var args = arguments;
      Meteor._noYieldsAllowed(function () {
        f.apply(null, args);
      });
    };
  }
};

var nextId = 1;
// computations whose callbacks we should call at flush time
var pendingComputations = [];
// `true` if a Tracker.flush is scheduled, or if we are in Tracker.flush now
var willFlush = false;
// `true` if we are in Tracker.flush now
var inFlush = false;
// `true` if we are computing a computation now, either first time
// or recompute.  This matches Tracker.active unless we are inside
// Tracker.nonreactive, which nullfies currentComputation even though
// an enclosing computation may still be running.
var inCompute = false;
// `true` if the `_throwFirstError` option was passed in to the call
// to Tracker.flush that we are in. When set, throw rather than log the
// first error encountered while flushing. Before throwing the error,
// finish flushing (from a finally block), logging any subsequent
// errors.
var throwFirstError = false;

var afterFlushCallbacks = [];

var requireFlush = function () {
  if (! willFlush) {
    // We want this code to work without Meteor, see debugFunc above
    if (typeof Meteor !== "undefined")
      Meteor._setImmediate(Tracker._runFlush);
    else
      setTimeout(Tracker._runFlush, 0);
    willFlush = true;
  }
};

// Tracker.Computation constructor is visible but private
// (throws an error if you try to call it)
var constructingComputation = false;

//
// http://docs.meteor.com/#tracker_computation

/**
 * @summary A Computation object represents code that is repeatedly rerun
 * in response to
 * reactive data changes. Computations don't have return values; they just
 * perform actions, such as rerendering a template on the screen. Computations
 * are created using Tracker.autorun. Use stop to prevent further rerunning of a
 * computation.
 * @instancename computation
 */
Tracker.Computation = function (f, parent, onError) {
  if (! constructingComputation)
    throw new Error(
      "Tracker.Computation constructor is private; use Tracker.autorun");
  constructingComputation = false;

  var self = this;

  // http://docs.meteor.com/#computation_stopped

  /**
   * @summary True if this computation has been stopped.
   * @locus Client
   * @memberOf Tracker.Computation
   * @instance
   * @name  stopped
   */
  self.stopped = false;

  // http://docs.meteor.com/#computation_invalidated

  /**
   * @summary True if this computation has been invalidated (and not yet rerun), or if it has been stopped.
   * @locus Client
   * @memberOf Tracker.Computation
   * @instance
   * @name  invalidated
   * @type {Boolean}
   */
  self.invalidated = false;

  // http://docs.meteor.com/#computation_firstrun

  /**
   * @summary True during the initial run of the computation at the time `Tracker.autorun` is called, and false on subsequent reruns and at other times.
   * @locus Client
   * @memberOf Tracker.Computation
   * @instance
   * @name  firstRun
   * @type {Boolean}
   */
  self.firstRun = true;

  self._id = nextId++;
  self._onInvalidateCallbacks = [];
  self._onStopCallbacks = [];
  // the plan is at some point to use the parent relation
  // to constrain the order that computations are processed
  self._parent = parent;
  self._func = f;
  self._onError = onError;
  self._recomputing = false;

  // Register the computation within the global Tracker.
  Tracker._computations[self._id] = self;

  var errored = true;
  try {
    self._compute();
    errored = false;
  } finally {
    self.firstRun = false;
    if (errored)
      self.stop();
  }
};

// http://docs.meteor.com/#computation_oninvalidate

/**
 * @summary Registers `callback` to run when this computation is next invalidated, or runs it immediately if the computation is already invalidated.  The callback is run exactly once and not upon future invalidations unless `onInvalidate` is called again after the computation becomes valid again.
 * @locus Client
 * @param {Function} callback Function to be called on invalidation. Receives one argument, the computation that was invalidated.
 */
Tracker.Computation.prototype.onInvalidate = function (f) {
  var self = this;

  if (typeof f !== 'function')
    throw new Error("onInvalidate requires a function");

  if (self.invalidated) {
    Tracker.nonreactive(function () {
      withNoYieldsAllowed(f)(self);
    });
  } else {
    self._onInvalidateCallbacks.push(f);
  }
};

/**
 * @summary Registers `callback` to run when this computation is stopped, or runs it immediately if the computation is already stopped.  The callback is run after any `onInvalidate` callbacks.
 * @locus Client
 * @param {Function} callback Function to be called on stop. Receives one argument, the computation that was stopped.
 */
Tracker.Computation.prototype.onStop = function (f) {
  var self = this;

  if (typeof f !== 'function')
    throw new Error("onStop requires a function");

  if (self.stopped) {
    Tracker.nonreactive(function () {
      withNoYieldsAllowed(f)(self);
    });
  } else {
    self._onStopCallbacks.push(f);
  }
};

// http://docs.meteor.com/#computation_invalidate

/**
 * @summary Invalidates this computation so that it will be rerun.
 * @locus Client
 */
Tracker.Computation.prototype.invalidate = function () {
  var self = this;
  if (! self.invalidated) {
    // if we're currently in _recompute(), don't enqueue
    // ourselves, since we'll rerun immediately anyway.
    if (! self._recomputing && ! self.stopped) {
      requireFlush();
      pendingComputations.push(this);
    }

    self.invalidated = true;

    // callbacks can't add callbacks, because
    // self.invalidated === true.
    for(var i = 0, f; f = self._onInvalidateCallbacks[i]; i++) {
      Tracker.nonreactive(function () {
        withNoYieldsAllowed(f)(self);
      });
    }
    self._onInvalidateCallbacks = [];
  }
};

// http://docs.meteor.com/#computation_stop

/**
 * @summary Prevents this computation from rerunning.
 * @locus Client
 */
Tracker.Computation.prototype.stop = function () {
  var self = this;

  if (! self.stopped) {
    self.stopped = true;
    self.invalidate();
    // Unregister from global Tracker.
    delete Tracker._computations[self._id];
    for(var i = 0, f; f = self._onStopCallbacks[i]; i++) {
      Tracker.nonreactive(function () {
        withNoYieldsAllowed(f)(self);
      });
    }
    self._onStopCallbacks = [];
  }
};

Tracker.Computation.prototype._compute = function () {
  var self = this;
  self.invalidated = false;

  var previous = Tracker.currentComputation;
  setCurrentComputation(self);
  var previousInCompute = inCompute;
  inCompute = true;
  try {
    withNoYieldsAllowed(self._func)(self);
  } finally {
    setCurrentComputation(previous);
    inCompute = previousInCompute;
  }
};

Tracker.Computation.prototype._needsRecompute = function () {
  var self = this;
  return self.invalidated && ! self.stopped;
};

Tracker.Computation.prototype._recompute = function () {
  var self = this;

  self._recomputing = true;
  try {
    if (self._needsRecompute()) {
      try {
        self._compute();
      } catch (e) {
        if (self._onError) {
          self._onError(e);
        } else {
          _throwOrLog("recompute", e);
        }
      }
    }
  } finally {
    self._recomputing = false;
  }
};

//
// http://docs.meteor.com/#tracker_dependency

/**
 * @summary A Dependency represents an atomic unit of reactive data that a
 * computation might depend on. Reactive data sources such as Session or
 * Minimongo internally create different Dependency objects for different
 * pieces of data, each of which may be depended on by multiple computations.
 * When the data changes, the computations are invalidated.
 * @class
 * @instanceName dependency
 */
Tracker.Dependency = function () {
  this._dependentsById = {};
};

// http://docs.meteor.com/#dependency_depend
//
// Adds `computation` to this set if it is not already
// present.  Returns true if `computation` is a new member of the set.
// If no argument, defaults to currentComputation, or does nothing
// if there is no currentComputation.

/**
 * @summary Declares that the current computation (or `fromComputation` if given) depends on `dependency`.  The computation will be invalidated the next time `dependency` changes.

If there is no current computation and `depend()` is called with no arguments, it does nothing and returns false.

Returns true if the computation is a new dependent of `dependency` rather than an existing one.
 * @locus Client
 * @param {Tracker.Computation} [fromComputation] An optional computation declared to depend on `dependency` instead of the current computation.
 * @returns {Boolean}
 */
Tracker.Dependency.prototype.depend = function (computation) {
  if (! computation) {
    if (! Tracker.active)
      return false;

    computation = Tracker.currentComputation;
  }
  var self = this;
  var id = computation._id;
  if (! (id in self._dependentsById)) {
    self._dependentsById[id] = computation;
    computation.onInvalidate(function () {
      delete self._dependentsById[id];
    });
    return true;
  }
  return false;
};

// http://docs.meteor.com/#dependency_changed

/**
 * @summary Invalidate all dependent computations immediately and remove them as dependents.
 * @locus Client
 */
Tracker.Dependency.prototype.changed = function () {
  var self = this;
  for (var id in self._dependentsById)
    self._dependentsById[id].invalidate();
};

// http://docs.meteor.com/#dependency_hasdependents

/**
 * @summary True if this Dependency has one or more dependent Computations, which would be invalidated if this Dependency were to change.
 * @locus Client
 * @returns {Boolean}
 */
Tracker.Dependency.prototype.hasDependents = function () {
  var self = this;
  for(var id in self._dependentsById)
    return true;
  return false;
};

// http://docs.meteor.com/#tracker_flush

/**
 * @summary Process all reactive updates immediately and ensure that all invalidated computations are rerun.
 * @locus Client
 */
Tracker.flush = function (options) {
  Tracker._runFlush({ finishSynchronously: true,
                      throwFirstError: options && options._throwFirstError });
};

// Run all pending computations and afterFlush callbacks.  If we were not called
// directly via Tracker.flush, this may return before they're all done to allow
// the event loop to run a little before continuing.
Tracker._runFlush = function (options) {
  // XXX What part of the comment below is still true? (We no longer
  // have Spark)
  //
  // Nested flush could plausibly happen if, say, a flush causes
  // DOM mutation, which causes a "blur" event, which runs an
  // app event handler that calls Tracker.flush.  At the moment
  // Spark blocks event handlers during DOM mutation anyway,
  // because the LiveRange tree isn't valid.  And we don't have
  // any useful notion of a nested flush.
  //
  // https://app.asana.com/0/159908330244/385138233856
  if (inFlush)
    throw new Error("Can't call Tracker.flush while flushing");

  if (inCompute)
    throw new Error("Can't flush inside Tracker.autorun");

  options = options || {};

  inFlush = true;
  willFlush = true;
  throwFirstError = !! options.throwFirstError;

  var recomputedCount = 0;
  var finishedTry = false;
  try {
    while (pendingComputations.length ||
           afterFlushCallbacks.length) {

      // recompute all pending computations
      while (pendingComputations.length) {
        var comp = pendingComputations.shift();
        comp._recompute();
        if (comp._needsRecompute()) {
          pendingComputations.unshift(comp);
        }

        if (! options.finishSynchronously && ++recomputedCount > 1000) {
          finishedTry = true;
          return;
        }
      }

      if (afterFlushCallbacks.length) {
        // call one afterFlush callback, which may
        // invalidate more computations
        var func = afterFlushCallbacks.shift();
        try {
          func();
        } catch (e) {
          _throwOrLog("afterFlush", e);
        }
      }
    }
    finishedTry = true;
  } finally {
    if (! finishedTry) {
      // we're erroring due to throwFirstError being true.
      inFlush = false; // needed before calling `Tracker.flush()` again
      // finish flushing
      Tracker._runFlush({
        finishSynchronously: options.finishSynchronously,
        throwFirstError: false
      });
    }
    willFlush = false;
    inFlush = false;
    if (pendingComputations.length || afterFlushCallbacks.length) {
      // We're yielding because we ran a bunch of computations and we aren't
      // required to finish synchronously, so we'd like to give the event loop a
      // chance. We should flush again soon.
      if (options.finishSynchronously) {
        throw new Error("still have more to do?");  // shouldn't happen
      }
      setTimeout(requireFlush, 10);
    }
  }
};

// http://docs.meteor.com/#tracker_autorun
//
// Run f(). Record its dependencies. Rerun it whenever the
// dependencies change.
//
// Returns a new Computation, which is also passed to f.
//
// Links the computation to the current computation
// so that it is stopped if the current computation is invalidated.

/**
 * @callback Tracker.ComputationFunction
 * @param {Tracker.Computation}
 */
/**
 * @summary Run a function now and rerun it later whenever its dependencies
 * change. Returns a Computation object that can be used to stop or observe the
 * rerunning.
 * @locus Client
 * @param {Tracker.ComputationFunction} runFunc The function to run. It receives
 * one argument: the Computation object that will be returned.
 * @param {Object} [options]
 * @param {Function} options.onError Optional. The function to run when an error
 * happens in the Computation. The only argument it recieves is the Error
 * thrown. Defaults to the error being logged to the console.
 * @returns {Tracker.Computation}
 */
Tracker.autorun = function (f, options) {
  if (typeof f !== 'function')
    throw new Error('Tracker.autorun requires a function argument');

  options = options || {};

  constructingComputation = true;
  var c = new Tracker.Computation(
    f, Tracker.currentComputation, options.onError);

  if (Tracker.active)
    Tracker.onInvalidate(function () {
      c.stop();
    });

  return c;
};

// http://docs.meteor.com/#tracker_nonreactive
//
// Run `f` with no current computation, returning the return value
// of `f`.  Used to turn off reactivity for the duration of `f`,
// so that reactive data sources accessed by `f` will not result in any
// computations being invalidated.

/**
 * @summary Run a function without tracking dependencies.
 * @locus Client
 * @param {Function} func A function to call immediately.
 */
Tracker.nonreactive = function (f) {
  var previous = Tracker.currentComputation;
  setCurrentComputation(null);
  try {
    return f();
  } finally {
    setCurrentComputation(previous);
  }
};

// http://docs.meteor.com/#tracker_oninvalidate

/**
 * @summary Registers a new [`onInvalidate`](#computation_oninvalidate) callback on the current computation (which must exist), to be called immediately when the current computation is invalidated or stopped.
 * @locus Client
 * @param {Function} callback A callback function that will be invoked as `func(c)`, where `c` is the computation on which the callback is registered.
 */
Tracker.onInvalidate = function (f) {
  if (! Tracker.active)
    throw new Error("Tracker.onInvalidate requires a currentComputation");

  Tracker.currentComputation.onInvalidate(f);
};

// http://docs.meteor.com/#tracker_afterflush

/**
 * @summary Schedules a function to be called during the next flush, or later in the current flush if one is in progress, after all invalidated computations have been rerun.  The function will be run once and not on subsequent flushes unless `afterFlush` is called again.
 * @locus Client
 * @param {Function} callback A function to call at flush time.
 */
Tracker.afterFlush = function (f) {
  afterFlushCallbacks.push(f);
  requireFlush();
};

/* --------------------------- deprecated.js ------------------------------ */

// These functions used to be on the Meteor object (and worked slightly
// differently).
// XXX COMPAT WITH 0.5.7
Meteor.flush = Tracker.flush;
Meteor.autorun = Tracker.autorun;

// We used to require a special "autosubscribe" call to reactively subscribe to
// things. Now, it works with autorun.
// XXX COMPAT WITH 0.5.4
Meteor.autosubscribe = Tracker.autorun;

// This Tracker API briefly existed in 0.5.8 and 0.5.9
// XXX COMPAT WITH 0.5.9
Tracker.depend = function (d) {
  return d.depend();
};

Deps = Tracker;

/* -------------------------------- FVIEW --------------------------------- */

// Unfortunately famo.us Engine also uses private methods, so let's just
// cap at 1/4 of what we expect that limit to be to err on the side of
// caution and hope for the best.

var MAX_DEFER_FRAME_TIME = 2;
var COMPUTATION_WARN_THRESHOLD = 5;

Tracker._FViewRunFlush = function (options) {
  if (inFlush)
    throw new Error("Can't call Tracker.flush while flushing");

  if (inCompute)
    throw new Error("Can't flush inside Tracker.autorun");

  options = options || {};

  inFlush = true;
  willFlush = true;
  throwFirstError = !! options.throwFirstError;

  // fviews change #2 - watch frame time
  var flushStartTime = Date.now();
  var computationStartTime;

  var recomputedCount = 0;
  var finishedTry = false;
  try {
    while (pendingComputations.length ||
           afterFlushCallbacks.length) {

      // recompute all pending computations
      while (pendingComputations.length) {
        var comp = pendingComputations.shift();
        computationStartTime = Date.now(); // fview#3
        comp._recompute();
        if (comp._needsRecompute()) {
          pendingComputations.unshift(comp);
        }

        if (! options.finishSynchronously && (++recomputedCount > 1000 || // fviews#2
            Date.now() - flushStartTime > MAX_DEFER_FRAME_TIME)) {
          // This log.debug will fall away after all this is well tested
          log.debug('Tracker._FViewRunFlush -- splitting after ' +
            (Date.now() - flushStartTime) + 'ms, ' +
            pendingComputations.length + ' pending computations');

          // This is definitely useful to keep around
          if (Tracker.warnOnLongComputations === true &&
              Date.now() - computationStartTime > COMPUTATION_WARN_THRESHOLD) {
            var func = Tracker.showFullFuncsInWarnings ? comp._func :
              ( comp._func.toString()
                .replace(/^function ([^\(]*)\(([^\)]*)\)[\s\S]*$/, 'function $1($2) ') +
                (comp._func.displayName || comp._func.name || ''));
            log.debug("The following computation took " +
              (Date.now() - computationStartTime) + 'ms to complete:' /* : ' + func */, 
              func, Tracker.showComputationsInWarnings ? comp : "");
          }

          finishedTry = true;
          return;
        }
      }

      if (afterFlushCallbacks.length) {
        // call one afterFlush callback, which may
        // invalidate more computations
        var func = afterFlushCallbacks.shift();
        try {
          func();
        } catch (e) {
          _throwOrLog("afterFlush", e);
        }
      }
    }
    finishedTry = true;
  } finally {
    if (! finishedTry) {
      // we're erroring due to throwFirstError being true.
      inFlush = false; // needed before calling `Tracker.flush()` again
      // finish flushing
      Tracker._runFlush({
        finishSynchronously: options.finishSynchronously,
        throwFirstError: false
      });
    }
    willFlush = false;
    inFlush = false;
    if (pendingComputations.length || afterFlushCallbacks.length) {
      // We're yielding because we ran a bunch of computations and we aren't
      // required to finish synchronously, so we'd like to give the event loop a
      // chance. We should flush again soon.
      if (options.finishSynchronously) {
        throw new Error("still have more to do?");  // shouldn't happen
      }
      // fviews#5
      if (recomputedCount > 1000)
        setTimeout(requireFlush, 10);
      else
        //requireFlush(); // defers anyway
        // Engine.nextTick(requireFlush);  -- could do this if we track famous' time.
        FamousEngine.requestUpdateOnNextTick({
          onUpdate: function(time) {
            requireFlush();
          }
        });
    }
  }
};

FView.ready(function() {
  var clock = FamousEngine.getClock();

  // Would be better to figure out where we are in a tick to limit the
  // threshold, and then have a resumed flush be in the next tick
  // log.debug('Overriding Tracker.requireFlush to pause/resume after ' +
  //  MAX_DEFER_FRAME_TIME + 'ms');
  requireFlush = function () {
    if (! willFlush) {
      clock.setTimeout(Tracker._FViewRunFlush, 0);
      willFlush = true;
    }
  };
  Tracker.warnOnLongComputations = true;
  Tracker.showFullFuncsInWarnings = false;
  Tracker.showComputationsInWarnings = false;
});