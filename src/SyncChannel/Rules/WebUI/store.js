define([], function () {
    'use strict';

    // ===================================================================
    // Shared committed/working collections and stable selections. Editors
    // may mutate only their own working collection; dependent-tab events are
    // published after Save or Discard, never for another screen's draft.
    // ===================================================================

    var state = {
        connections: [],
        connectionsSavedSnapshot: null,
        connectionsSavedFullSnapshot: null,

        schemas: [],
        currentSchemaId: '',

        ruleSetsFile: null,
        currentRuleSetId: '',
        ruleSetsSavedSnapshot: null,

        persistedConnectionIds: {},
        currentTree: null
    };

    var listeners = {};

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

    // Read-only structural query shared by every destructive editor action.
    // Returning references (rather than a second boolean-only check) keeps
    // the decision and the actionable dependency message based on exactly
    // the same result.
    function folderTreeReferencesForRuleSets(node, ruleSetIds, parentPath) {
        if (!node) return [];
        var path = (parentPath || []).concat([node.DisplayName || '(unnamed folder)']);
        var result = (node.Fetches || [])
            .filter(function (fetch) { return ruleSetIds.indexOf(fetch.RuleSetId) !== -1; })
            .map(function (fetch) {
                return {
                    FolderId: node.Id,
                    FetchId: fetch.Id,
                    RuleSetId: fetch.RuleSetId,
                    Path: path.join(' → '),
                    FetchName: fetch.DisplayLabel || '(unnamed fetch)'
                };
            });
        (node.Children || []).forEach(function (child) {
            result = result.concat(folderTreeReferencesForRuleSets(child, ruleSetIds, path));
        });
        return result;
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
        folderTreeReferencesForRuleSets: folderTreeReferencesForRuleSets,
        ruleSetsForSchema: ruleSetsForSchema
    };
});
