import { useLocalSearchParams } from 'expo-router';
import { SocialAddFriendPage } from '@/prototype/social';
export default function AddFriend() {
  const { handle } = useLocalSearchParams<{ handle?: string }>();
  return <SocialAddFriendPage initialHandle={typeof handle === 'string' ? handle : undefined} />;
}
