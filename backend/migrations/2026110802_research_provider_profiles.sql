-- Existing financial identities remain stable on the wire. Research profiles
-- are projected through the additive research_provider_id response field.
ALTER TABLE plugin_connections DROP CONSTRAINT financial_provider_binding;
ALTER TABLE plugin_connections ADD CONSTRAINT financial_provider_binding CHECK (
    financial_provider_id IS NULL OR (
        connection_kind = 'remote_mcp' AND builtin_service_id IS NULL AND
        financial_provider_id IN (
            'ifind', 'jin10', 'massive', 'alphavantage', 'twelvedata', 'coingecko',
            'tavily', 'fred'
        )
    )
);
