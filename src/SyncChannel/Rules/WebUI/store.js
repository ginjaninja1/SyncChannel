define([], function () {
    'use strict';

    // ===================================================================
    // Single owner of all cross-tab mutable state. Nothing outside this
    // module ever assigns to these directly — always through a store
    // method, so every mutation has exactly one place it could have gone
    // wrong. Tabs subscribe to the events they care about instead of
    // calling each other's render functions.
    // ===================================================================

    var state = {
        connections: [],
        connectionsSavedSnapshot: null,
        connectionsSavedFullSnapshot: null,
        pendingConnectionRemovals: {},
        connectionSchemaOrder: {},
        connectionRuleOrder: {},

        schemas: [],
        currentSchemaId: '',

        ruleSetsFile: null,
        currentRuleSetIndex: -1,
        ruleSetsSavedSnapshot: null,
        ruleSetsHaveUnsavedChanges: false,
        ruleSetDomEditedById: {},
        builtInRuleDraftRootsById: {},

        persistedConnectionIds: {},
        schemaOperationChangedRuleSets: false,

        currentTree: null
    };

    var listeners = {};

    // Shared between ruleBuilderTab (marks a rule set edited on every
    // keystroke/drag) and ruleSetManagerTab (reads it to render the
    // warning banner, clears it on save/discard) — lives here rather than
    // in either tab so neither needs a direct dependency on the other.
    // Flag-based, not a content diff: matches the original
    // ruleSetDomEditedById behavior — any edit marks the rule set dirty
    // until the next save/discard, rather than comparing serialized trees.
    function markRuleSetEdited(ruleSetId) {
        if (!ruleSetId) return;
        var edited = state.ruleSetDomEditedById;
        edited[ruleSetId] = true;
        state.ruleSetsHaveUnsavedChanges = true;
    }

    function isRuleSetEdited(ruleSetId) {
        return !!state.ruleSetDomEditedById[ruleSetId];
    }

    function clearRuleSetEditFlags() {
        state.ruleSetDomEditedById = {};
        state.ruleSetsHaveUnsavedChanges = false;
    }

    function isRuleSetsDirty() {
        return state.ruleSetsSavedSnapshot !== null && state.ruleSetsHaveUnsavedChanges;
    }

    function on(eventName, handler) {
        (listeners[eventName] = listeners[eventName] || []).push(handler);
        return function off() {
            listeners[eventName] = (listeners[eventName] || []).filter(function (h) { return h !== handler; });
        };
    }

    function emit(eventName) {
        (listeners[eventName] || []).slice().forEach(function (h) { h(); });
    }

    function get(key) { return state[key]; }

    // Whole-array/object replace, not deep merge — callers pass a complete
    // new value (matches how the original code reassigned these vars
    // wholesale, e.g. after a JSON.parse of a saved snapshot).
    function set(key, value, eventName) {
        state[key] = value;
        if (eventName) emit(eventName);
    }

    // ---- Read helpers used by more than one tab (kept here since they
    // read straight off shared state; a tab-specific helper stays in its
    // own tab module instead) ----

    function findConnection(connectionId) {
        return state.connections.filter(function (x) { return x.Id === connectionId; })[0];
    }

    function connectionLabel(connectionId) {
        var c = findConnection(connectionId);
        return c ? c.DisplayLabel : '(unknown connection)';
    }

    function schemasForConnection(connectionId) {
        if (!connectionId) return [];
        return state.schemas.filter(function (s) { return s.ConnectionId === connectionId; });
    }

    function schemaOptionLabel(schema) {
        return (schema.IsBuiltIn ? '[Built-in] ' : '') +
            (schema.DisplayName || '(unnamed)') + (schema.IsBuiltIn ? ' \uD83D\uDD12' : '');
    }

    function currentSchema() {
        return state.schemas.filter(function (s) { return s.Id === state.currentSchemaId; })[0] || null;
    }

    function schemaLabel(id) {
        var s = state.schemas.filter(function (x) { return x.Id === id; })[0];
        return s ? schemaOptionLabel(s) : '(unknown schema)';
    }

    function schemaNameExists(connectionId, name, exceptId) {
        var normalized = (name || '').trim().toLowerCase();
        return state.schemas.some(function (s) {
            return s.ConnectionId === connectionId && s.Id !== exceptId &&
                (s.DisplayName || '').trim().toLowerCase() === normalized;
        });
    }

    function ruleSetById(id) {
        return (state.ruleSetsFile.RuleSets || []).filter(function (rs) { return rs.Id === id; })[0];
    }

    function ruleSetLabel(id) {
        var rs = ruleSetById(id);
        return rs ? ((rs.IsBuiltIn ? '[Built-in] ' : '') + rs.Name + (rs.IsBuiltIn ? ' \uD83D\uDD12' : '')) : '(unknown rule set)';
    }

    function ruleSetNameExists(schemaId, name, exceptId) {
        var normalized = (name || '').trim().toLowerCase();
        return state.ruleSetsFile.RuleSets.some(function (rs) {
            return rs.EndpointSchemaId === schemaId && rs.Id !== exceptId &&
                (rs.Name || '').trim().toLowerCase() === normalized;
        });
    }

    function schemaForRuleSetId(id) {
        var rs = ruleSetById(id);
        if (!rs) return null;
        return state.schemas.filter(function (s) { return s.Id === rs.EndpointSchemaId; })[0] || null;
    }

    function ruleSetsForSchema(schemaId) {
        return state.ruleSetsFile.RuleSets
            .map(function (rs, idx) { return { rs: rs, idx: idx }; })
            .filter(function (x) { return x.rs.EndpointSchemaId === schemaId; });
    }

    function connectionForRuleSetId(id) {
        var schema = schemaForRuleSetId(id);
        return schema ? findConnection(schema.ConnectionId) : null;
    }

    // Read-only structural query against the folder tree, used by the
    // Connections tab to block removing a connection whose Rule Sets are
    // still wired to a Folder Fetch. Lives here (not in folderTreeTab)
    // because it's a pure query over state.currentTree, not a render —
    // callers never need folderTreeTab's DOM/rendering code just to ask
    // this question.
    function folderTreeUsesAnyRuleSet(node, ruleSetIds) {
        if (!node) return false;
        var fetches = node.Fetches || [];
        if (fetches.some(function (f) { return ruleSetIds.indexOf(f.RuleSetId) !== -1; })) return true;
        return (node.Children || []).some(function (child) { return folderTreeUsesAnyRuleSet(child, ruleSetIds); });
    }

    return {
        on: on,
        emit: emit,
        get: get,
        set: set,

        findConnection: findConnection,
        connectionLabel: connectionLabel,
        schemasForConnection: schemasForConnection,
        schemaOptionLabel: schemaOptionLabel,
        currentSchema: currentSchema,
        schemaLabel: schemaLabel,
        schemaNameExists: schemaNameExists,
        ruleSetById: ruleSetById,
        ruleSetLabel: ruleSetLabel,
        ruleSetNameExists: ruleSetNameExists,
        schemaForRuleSetId: schemaForRuleSetId,
        connectionForRuleSetId: connectionForRuleSetId,
        folderTreeUsesAnyRuleSet: folderTreeUsesAnyRuleSet,
        ruleSetsForSchema: ruleSetsForSchema,
        markRuleSetEdited: markRuleSetEdited,
        isRuleSetEdited: isRuleSetEdited,
        clearRuleSetEditFlags: clearRuleSetEditFlags,
        isRuleSetsDirty: isRuleSetsDirty
    };
});
