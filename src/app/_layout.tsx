import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import Purchases from 'react-native-purchases';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';
import { AuthContext } from '../hooks/useAuth';

SplashScreen.preventAutoHideAsync();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const REVENUECAT_IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY || '';
const REVENUECAT_ANDROID_KEY = process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY || '';

export default function RootLayout() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [purchasesConfigured, setPurchasesConfigured] = useState(false);

  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  // Supabase auth listener
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Push notifications
  useEffect(() => {
    if (!Device.isDevice) return;
    Notifications.getPermissionsAsync().then(({ status }) => {
      if (status !== 'granted') {
        Notifications.requestPermissionsAsync();
      }
    });
  }, []);

  // RevenueCat
  useEffect(() => {
    const key = Platform.OS === 'ios' ? REVENUECAT_IOS_KEY : REVENUECAT_ANDROID_KEY;
    if (key) {
      Purchases.configure({ apiKey: key });
      setPurchasesConfigured(true);
    }
  }, []);

  // Keep RevenueCat user identity in sync with Supabase auth session.
  useEffect(() => {
    if (!purchasesConfigured) return;
    (async () => {
      try {
        if (session?.user?.id) {
          await Purchases.logIn(session.user.id);
        } else {
          await Purchases.logOut();
        }
      } catch (e) {
        console.warn('[RevenueCat] Identity sync failed:', e);
      }
    })();
  }, [purchasesConfigured, session?.user?.id]);

  return (
    <AuthContext.Provider value={{ session, loading }}>
      <StatusBar style="light" backgroundColor="#0A0A0F" />
      <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
        <Stack.Screen name="index" />
      </Stack>
    </AuthContext.Provider>
  );
}
