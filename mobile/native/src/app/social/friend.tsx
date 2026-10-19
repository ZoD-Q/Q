import { useLocalSearchParams } from 'expo-router';
import { SocialFriendPage } from '@/prototype/social';
export default function Friend() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <SocialFriendPage userId={typeof id === 'string' ? id : ''} />;
}
