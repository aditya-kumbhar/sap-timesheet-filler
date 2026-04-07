// SAP Timesheet Filler — Page World Bridge
// Injected as a <script src> tag so it runs in the page's JS context,
// where sap.ui.getCore() is accessible. Communicates with the content
// script via CustomEvents on the document.

document.addEventListener('__sapFiller_firePress', function (e) {
  var id = e.detail.id;
  try {
    // Value-help icon (-vhi): fire valueHelpRequest on the parent Input control
    if (id && id.endsWith('-vhi')) {
      var inputCtrlId = id.replace(/-vhi$/, '');
      var inputCtrl = sap.ui.getCore().byId(inputCtrlId);
      if (inputCtrl && inputCtrl.fireValueHelpRequest) {
        inputCtrl.fireValueHelpRequest({ fromSuggestions: false });
        return;
      }
    }

    var el = document.getElementById(id);

    // SAP SelectDialog list items (sapMLIB): the <li> id has a dynamic
    // "__itemNN-" prefix so byId never finds it. Instead, derive the stable
    // list control ID from the element's id by stripping the prefix, then
    // use the list control's items to trigger a tap via the UI5 control's
    // jQuery wrapper. This invokes SAP's internal ontap handler which
    // handles selection, fires confirm, and closes the dialog.
    if (el && el.classList.contains('sapMLIB')) {
      // The item's UI5 control is registered with the full DOM id (including
      // the dynamic "__itemNN-" prefix). The SelectDialog id is derived by
      // stripping the prefix and the trailing index.
      var itemCtrl = sap.ui.getCore().byId(el.id);
      var stableListId = el.id.replace(/^__item\d+-/, '').replace(/-\d+$/, '');
      var selectDialogId = stableListId.replace(/-list$/, '');
      var selectDialog = sap.ui.getCore().byId(selectDialogId);

      if (selectDialog && itemCtrl) {
        selectDialog.fireConfirm({ selectedItem: itemCtrl, selectedItems: [itemCtrl] });
        if (selectDialog._oDialog && selectDialog._oDialog.close) {
          selectDialog._oDialog.close();
        }
      }
      return;
    }

    // Regular UI5 button: firePress via Core API
    var ctrl = sap.ui.getCore().byId(id);
    if (ctrl && ctrl.firePress) {
      ctrl.firePress();
      return;
    }
  } catch (err) {}

  // Fallback: direct DOM click
  var el2 = document.getElementById(id);
  if (el2) el2.click();
});

document.addEventListener('__sapFiller_selectSegBtnItem', function (e) {
  // Trigger a jQuery tap on the SegmentedButton item — this is the most
  // reliable way to activate SAP's internal event handling for both
  // tab switches (Project/Attendance) and workplace selection.
  var el = document.getElementById(e.detail.id);
  if (el && typeof jQuery !== 'undefined') {
    jQuery(el).trigger('tap');
  }
});

document.addEventListener('__sapFiller_setValue', function (e) {
  try {
    var controlId = e.detail.id.replace(/-inner$/, '').replace(/-content$/, '');
    var ctrl = sap.ui.getCore().byId(controlId);
    if (ctrl && ctrl.setValue) {
      ctrl.setValue(e.detail.value);
      if (typeof ctrl.fireChange === 'function') {
        ctrl.fireChange({ value: e.detail.value });
      }
    }
  } catch (err) {}
});
