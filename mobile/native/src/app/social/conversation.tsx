import { useLocalSearchParams } from 'expo-router';
import { SocialConversationPage } from '@/prototype/social';
export default function Conversation() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <SocialConversationPage conversationId={typeof id === 'string' ? id : ''} />;
}
