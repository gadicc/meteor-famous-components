function famousEachRender(eachView, template, argFunc) {
  var fview = eachView.fview;
  var sequence = fview.sequence;				// fviews for Famous Render Tree
  var children = fview.children = [];		// children blaze views

  // For Blaze.currentView (see blaze/builtins.js#each)
  eachView.argVar = new Blaze.ReactiveVar;
  eachView.autorun(function () {
    eachView.argVar.set(argFunc());
  }, eachView.parentView);

  eachView.stopHandle = ObserveSequence.observe(function () {
      return eachView.argVar.get();
    }, {
      addedAt: function (id, item, index) {
        Deps.nonreactive(function () {
          var newItemView = Blaze.With(item, function() {
            return template.constructView();
          });

          /*
           * This is the repeated block inside famousEach, but not the actual node/
           * view/surface that gets created on render as this block's children
           */
          newItemView.fview = new MeteorFamousView(null, {}, true /* noAdd */);
          newItemView.fview.kind = 'famousEachBlock';
          newItemView.fview.sequence = sequence.child(index);

          if (fview.parent.pipeChildrenTo)
            newItemView.fview.pipeChildrenTo
              = fview.parent.pipeChildrenTo;

          children.splice(index, 0, newItemView);

          var unusedDiv = document.createElement('div');
          Blaze.render(newItemView, unusedDiv, eachView);

          //Blaze.materializeView(newItemView, eachView);
          //runRenderedCallback(newItemView);  // now called by Blaze.render
        });
      },
      removedAt: function (id, item, index) {
        // famousEachBlock, not individual Views
        Blaze.remove(children[index]);
        children.splice(index, 1);
      },
      changedAt: function (id, newItem, oldItem, index) {
        Deps.nonreactive(function () {
          children[index].dataVar.set(newItem);
        });
      },
      movedTo: function (id, doc, fromIndex, toIndex) {
        Deps.nonreactive(function () {
          var item = sequence.splice(fromIndex, 1)[0];
          sequence.splice(toIndex, 0, item);

          item = children.splice(fromIndex, 1)[0];
          children.splice(toIndex, 0, item);
        });
      }
    });
}

function famousEachCreated() {
  var blazeView = this.view;
  var fview = blazeView.fview = new MeteorFamousView(blazeView, {});

  log.debug('New famousEach' + " (#" + fview.id + ')'
    + ' (parent: ' + parentViewName(blazeView.parentView) + ','
    + ' template: ' + parentTemplateName(blazeView.parentView) + ')');

  fview.kind = 'famousEach';
  fview.sequence = fview.parent.sequence.child();

  // Contents of {{#famousEach}}block{{/famousEach}}
  if (blazeView.templateContentBlock)
    famousEachRender(blazeView, blazeView.templateContentBlock, function() {
      return Blaze.getData(blazeView);
    });
}

function famousEachDestroyed() {
  var blazeView = this.view;
  var fview = blazeView.fview;

  log.debug("Destroying FamousEach (#" + fview.id + ')');

  if (blazeView.stopHandle)
    blazeView.stopHandle.stop();

  var children = fview.children;
  for (var i=0; i < children.length; i++)
    Blaze.remove(children[i]);
}

// Keep this at the bottom; Firefox doesn't do function hoisting

FView.famousEachView = new Template(
  'famousEach',       // viewName: "famousEach"
  function() {        // Blaze.View "renderFunc"
    var view = this;  // Blaze.View, viewName "famousEach"
    // console.log(view);
    return null;
  }
);

Blaze.registerHelper('famousEach', FView.famousEachView);
FView.famousEachView.created = famousEachCreated;
FView.famousEachView.destroyed = famousEachDestroyed;

/*
FView.Each = function (argFunc, contentFunc, elseFunc) {
  var eachView = Blaze.View('Feach', function() {
    return null;
  });

  eachView.onCreated(function() {
    // For Blaze.currentView (see blaze/builtins.js#each)
    eachView.autorun(function () {
      eachView.argVar.set(argFunc());
    }, eachView.parentView);


  });

  return eachView;
}
Blaze.registerHelper('famousEach', FView.Each);
*/