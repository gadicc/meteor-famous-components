var fviews = FView._fviews = {};
var fviewCount = FView._fviewCount = 0;

/**
 * A meteor-famous-views node
 * @constructor
 * @param {dict} options
 * @param {MeteorFamousView} parent
 * @property {MeteorFamousView} parent
 * @property {array} children
 */
MeteorFamousView = FView._MeteorFamousView =
    function MeteorFamousView(parent, id, source) {
  this.id = id || fviewCount;
  fviews[this.id] = this;
  fviewCount++;

  log.debug("New " + this.className + " (#" + this.id + ") from " + source);

  this.type = this.className;
  this._source = source;        // waste of memory but useful to know
  this.children = [];
  this.parent = parent;
  if (parent)
    parent.children.push(this);
}

/**
 * Destroys a meteor-famous-view node.  This only handles the internal famous-views
 * stuff.  For cleaning up the Scene Graph, the template destroyed function should
 * be used (and then call this method -- since that's the first port of call).
 * This will, however, trigger template destroys on children.
 * @method
 */
MeteorFamousView.prototype.destroy = function(isTemplateDestroy) {
  var fview = this;

  if (isTemplateDestroy && fview._destroyPrevented)
    return fview._destroyPrevented();

  log.debug("Destroy (start) of " + this.type + " (#" + this.id + ") from " + this._source + ": children, components");

  // TODO, tests
  for (var i = this.children.length - 1; i >= 0; i--) {
    Blaze.remove(this.children[i].blazeView);
  };

   /* This is deistroying only odd number of node like if I have 5 children(1-5) node then its only remove 1,3,5 children because of array postion auto adjust after every node delete*/
  // _.each(this.children, function(child) {
    //child.destroy();
    // Blaze.remove(child.blazeView);
  // });


  // components
  // TODO, tests
  // TODO, is this the right place for this?
  _.each(this.components, function(comp) {
    comp.destroy();
  });

  // remove from parent
  if (this.parent)
    this.parent.children.splice(this.parent.children.indexOf(this), 1);

  log.debug("Destroy (finish) of " + this.type + " (#" + this.id + ") from " + this._source);

  delete fviews[this.id];
  this.removeFromParent();
};

FView.byId = function(id) {
  return fviews[id];
};

fviewParentFromBlazeView = FView._fviewParentFromBlazeView = function (blazeView) {
  while ((blazeView = blazeView.parentView) && blazeView.name.substr(0,6) !== 'Famous');
  return blazeView && blazeView._fview;
};

/**
 * The fviwe corresponding to the current template helper, event handler,
 * callback, or autorun. If there isn't one, null.  Uses Blaze.currentData
 * internally
 */
FView.current = function() {
  return FView.fromBlazeView(Blaze.currentView);
};

/* C&P from v0 */

FView.from = function(viewOrTplorEl) {
  if (viewOrTplorEl instanceof Blaze.View)
    return FView.fromBlazeView(viewOrTplorEl);
  else if (viewOrTplorEl instanceof Blaze.TemplateInstance)
    return FView.fromTemplate(viewOrTplorEl);
  else if (viewOrTplorEl && typeof viewOrTplorEl.nodeType === 'number')
    return FView.fromElement(viewOrTplorEl);
  else {
    throwError('FView.getData() expects BlazeView or TemplateInstance or ' +
        'DOM node, but got ', viewOrTplorEl);
  }
};

FView.fromBlazeView = function(view) {
  while (!view._fview && (view=view.parentView));
  return view ? view._fview : undefined;
};

FView.fromTemplate = FView.fromTemplateInstance = function(tplInstance) {
  return this.fromBlazeView(tplInstance.view);
};

FView.fromElement = function(el) {
  var view = Blaze.getView(el);
  return this.fromBlazeView(view);
};
