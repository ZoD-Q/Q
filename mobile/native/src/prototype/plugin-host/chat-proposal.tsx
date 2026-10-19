import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Action, Type, useDesign } from '../design';
import { decodeInvocation, pluginError, type PluginInvocation } from './core';
import { pluginRequest } from './client';
import { InvocationView } from './page';
import { WorkbenchError } from '../api-workbench/core';

export function ChatProposal({ id, token, connectionId, onContinue }: { id: string; token: string; connectionId: string; onContinue?: () => void }) {
  const { text, colors } = useDesign();
  const [invocation, setInvocation] = useState<PluginInvocation | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void pluginRequest(token, `/v1/plugins/invocations/${id}`, decodeInvocation, { signal: controller.signal }).then(result => {
      if (result.connection_id !== connectionId) throw new WorkbenchError('INVALID_RESPONSE');
      if (!controller.signal.aborted) setInvocation(result);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [id, token, connectionId, attempt]);
  if (!invocation) return <View style={{ gap: 10 }}>{error ? <><Type color={colors.danger}>{pluginError(error, text)}</Type><Action kind="ghost" label={text('查询调用', 'Read invocation')} onPress={() => { setError(null); setAttempt(value => value + 1); }} /></> : <ActivityIndicator color={colors.accent} />}</View>;
  return <InvocationView invocation={invocation} token={token} onChanged={setInvocation} onContinue={onContinue} autoShowResult />;
}
