-- Curated remote providers retain remote_mcp wire identity for old clients.
ALTER TABLE plugin_connections ADD COLUMN financial_provider_id TEXT;
ALTER TABLE plugin_connections ADD CONSTRAINT financial_provider_binding CHECK (
 financial_provider_id IS NULL OR (connection_kind='remote_mcp' AND builtin_service_id IS NULL AND
 financial_provider_id IN ('ifind','jin10','massive','alphavantage','twelvedata','coingecko'))
);
CREATE UNIQUE INDEX one_owned_financial_provider ON plugin_connections(user_id,financial_provider_id) WHERE financial_provider_id IS NOT NULL;
CREATE TABLE plugin_financial_credentials (
 connection_id UUID PRIMARY KEY REFERENCES plugin_connections(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES identities(id),
 connection_revision BIGINT NOT NULL,
 encrypted_secret BYTEA NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
