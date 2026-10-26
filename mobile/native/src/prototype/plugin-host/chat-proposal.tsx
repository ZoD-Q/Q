import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Action, Type, useDesign } from '../design';
import { decodeInvocation, pluginError, type PluginInvocation } from './core';
import { pluginRequest } from './client';
import { ChatInvocationView } from './chat-invocation';
import { WorkbenchError } from '../api-workbench/core';

export function ChatProposal({ id, token, connectionId, onContinue, mediaOnly = false, disabled = false }: { id: string; token: string; connectionId: string; onContinue?: () => void; mediaOnly?: boolean; disabled?: boolean }) {
  const { text, colors } = useDesign();
  const [invocation, setInvocation] = useState<PluginInvocation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void pluginRequest(token, `/v1/plugins/invocations/${id}`, decodeInvocation, { signal: controller.signal }).then(result => {
      if (result.id !== id || result.connection_id !== connectionId) throw new WorkbenchError('INVALID_RESPONSE');
      if (!controller.signal.aborted) setInvocation(result);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [id, token, connectionId, attempt]);
  if (mediaOnly && !invocation && !error) return null;
  if (!invocation) return <View style={{ gap: 10 }}>{error ? <><Type color={colors.danger}>{pluginError(error, text)}</Type><Action kind="ghost" label={text('重新查看', 'Try again')} onPress={() => { setError(null); setAttempt(value => value + 1); }} /></> : <ActivityIndicator color={colors.accent} accessibilityLabel={text('正在读取', 'Loading')} />}</View>;
  return <ChatInvocationView invocation={invocation} token={token} onChanged={setInvocation} onResolved={onContinue ? () => onContinue() : undefined} mediaOnly={mediaOnly} disabled={disabled} />;
}
