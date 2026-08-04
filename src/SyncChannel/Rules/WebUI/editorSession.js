define([], function () {
    'use strict';

    var editors = {};

    function canonicalJson(value, ignoredKeys) {
        var ignored = ignoredKeys || {};
        return JSON.stringify(value, function (key, current) {
            return ignored[key] ? undefined : current;
        });
    }

    function register(name, label, isDirty, isSaving) {
        editors[name] = {
            label: label,
            isDirty: isDirty,
            isSaving: isSaving || function () { return false; }
        };
        return function () { delete editors[name]; };
    }

    function blocker(exceptName) {
        var names = Object.keys(editors);
        for (var i = 0; i < names.length; i++) {
            var name = names[i];
            if (name === exceptName) continue;
            var editor = editors[name];
            if (editor.isSaving()) return { name: name, label: editor.label, saving: true };
            if (editor.isDirty()) return { name: name, label: editor.label, saving: false };
        }
        return null;
    }

    // All tab and entity navigation goes through this function. A caller may
    // exempt its own editor when it is not actually leaving that editor; for
    // entity changes within an editor, omit exceptName so its own dirty state
    // blocks the change too.
    function allowNavigation(destination, exceptName, onBlocked) {
        var blocked = blocker(exceptName);
        if (!blocked) return true;
        if (onBlocked) onBlocked(blocked);
        return false;
    }

    function blockedMessage(blocked) {
        return blocked.saving
            ? 'Wait for the save on the "' + blocked.label + '" screen to finish.'
            : 'Save or discard your changes on the "' + blocked.label + '" screen before navigating away.';
    }

    function setBusy(view, tabId, busy) {
        var root = view.querySelector('#tab-' + tabId);
        if (!root) return;
        root.querySelectorAll('button, input, select, textarea').forEach(function (control) {
            if (busy) {
                control.dataset.editorWasDisabled = control.disabled ? '1' : '0';
                control.disabled = true;
            } else if (control.dataset.editorWasDisabled !== undefined) {
                control.disabled = control.dataset.editorWasDisabled === '1';
                delete control.dataset.editorWasDisabled;
            }
        });
    }

    // After removing an item from an ordered selector, retain the item now at
    // the deleted index (the former next sibling); when there is no next item,
    // use the previous sibling. An empty list deliberately yields no selection.
    function selectionAfterDeletion(items, deletedIndex, getId) {
        if (!items || !items.length) return '';
        var index = Math.min(Math.max(deletedIndex, 0), items.length - 1);
        return getId(items[index]);
    }

    return {
        canonicalJson: canonicalJson,
        register: register,
        blocker: blocker,
        allowNavigation: allowNavigation,
        blockedMessage: blockedMessage,
        setBusy: setBusy,
        selectionAfterDeletion: selectionAfterDeletion
    };
});
