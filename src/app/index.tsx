import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  BackHandler,
  ActivityIndicator,
  StatusBar,
  Linking,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import * as Google from 'expo-auth-session/providers/google';
import Purchases from 'react-native-purchases';
import type { Session } from '@supabase/supabase-js';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';

WebBrowser.maybeCompleteAuthSession();

const PROD_WEB_URL = process.env.EXPO_PUBLIC_WEB_URL || 'https://x5marketing.com';
const DEV_WEB_URL = process.env.EXPO_PUBLIC_WEB_URL_DEV || PROD_WEB_URL;
const WEB_URL = (__DEV__ ? DEV_WEB_URL : PROD_WEB_URL).replace(/\/$/, '');

const ALLOWED_MESSAGE_TYPES = new Set([
  'WEB_READY',
  'LOGIN_APPLE',
  'LOGIN_GOOGLE',
  'LOGIN_EMAIL',
  'PAYMENT_REQUEST',
]);
const ALLOWED_PRODUCT_IDS = new Set(['x5_pro_monthly', 'x5_pro_yearly', 'x5_credits_1000']);

type NativeAuthProvider = 'apple' | 'google' | 'email';

type NativeAuthResult = {
  success: boolean;
  provider?: NativeAuthProvider;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
  canceled?: boolean;
  confirmationRequired?: boolean;
};

type BridgeIncomingMessage =
  | { type: 'WEB_READY' }
  | { type: 'LOGIN_APPLE' }
  | { type: 'LOGIN_GOOGLE' }
  | { type: 'LOGIN_EMAIL'; payload: { email: string; password: string; isSignUp?: boolean } }
  | { type: 'PAYMENT_REQUEST'; payload: { productId: string } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseIncomingMessage = (raw: string): BridgeIncomingMessage | null => {
  if (!raw || raw.length > 10_000) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const type = parsed.type;
  if (typeof type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(type)) return null;

  if (type === 'WEB_READY' || type === 'LOGIN_APPLE' || type === 'LOGIN_GOOGLE') {
    return { type };
  }

  if (type === 'LOGIN_EMAIL') {
    if (!isRecord(parsed.payload)) return null;
    const email = parsed.payload.email;
    const password = parsed.payload.password;
    const isSignUp = parsed.payload.isSignUp;

    if (typeof email !== 'string' || !email.includes('@') || email.length > 320) return null;
    if (typeof password !== 'string' || password.length < 6 || password.length > 200) return null;
    if (isSignUp !== undefined && typeof isSignUp !== 'boolean') return null;

    return { type, payload: { email, password, isSignUp } };
  }

  if (!isRecord(parsed.payload)) return null;
  const productId = parsed.payload.productId;
  if (typeof productId !== 'string' || productId.length < 3 || productId.length > 64) return null;
  if (!ALLOWED_PRODUCT_IDS.has(productId)) return null;

  return { type: 'PAYMENT_REQUEST', payload: { productId } };
};

const toOrigin = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
};

/** Upsert profile on first sign-in (ignoreDuplicates keeps existing data). */
const ensureProfile = async (session: Session) => {
  const user = session.user;
  await supabase.from('profiles').upsert(
    {
      id: user.id,
      name: user.user_metadata?.full_name || user.user_metadata?.name || 'User',
      email: user.email,
      plan: 'free',
      credits: 50,
    },
    { onConflict: 'id', ignoreDuplicates: true },
  );
};

export default function MainScreen() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [webReady, setWebReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const { session } = useAuth();

  const webUrl = useMemo(() => WEB_URL, []);

  const allowedOrigins = useMemo(() => {
    const base = [WEB_URL, PROD_WEB_URL, DEV_WEB_URL, 'http://localhost:5176'];
    const result = new Set<string>();
    for (const value of base) {
      const origin = toOrigin(value);
      if (origin) result.add(origin);
    }
    return Array.from(result);
  }, []);

  const isTrustedUrl = useCallback(
    (url: string | undefined) => {
      if (!url) return false;
      if (url === 'about:blank') return true;
      try {
        const parsed = new URL(url);
        const origin = `${parsed.protocol}//${parsed.host}`;
        return allowedOrigins.includes(origin);
      } catch {
        return false;
      }
    },
    [allowedOrigins],
  );

  const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID;
  const googleAndroidClientId = process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID;
  const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID;
  const googleEnabled = !!(Platform.OS === 'ios' ? googleIosClientId : googleAndroidClientId);

  const [, googleResponse, googlePromptAsync] = Google.useIdTokenAuthRequest({
    iosClientId: googleIosClientId || 'placeholder.apps.googleusercontent.com',
    androidClientId: googleAndroidClientId || 'placeholder.apps.googleusercontent.com',
    webClientId: googleWebClientId || 'placeholder.apps.googleusercontent.com',
  });

  const dispatchAuthResult = useCallback((detail: NativeAuthResult) => {
    const json = JSON.stringify(detail);
    webViewRef.current?.injectJavaScript(`
      window.dispatchEvent(new CustomEvent('nativeAuthResult', { detail: ${json} }));
      window.dispatchEvent(new CustomEvent('appleSignInResult', { detail: ${json} }));
      true;
    `);
  }, []);

  const dispatchAuthBootstrap = useCallback((nextSession: Session) => {
    const user = nextSession.user;
    const bootstrapUser = {
      id: user.id,
      name: user.user_metadata?.full_name || user.user_metadata?.name || user.email?.split('@')[0] || 'User',
      email: user.email || undefined,
      avatar: user.user_metadata?.avatar_url || undefined,
      isGuest: false,
      plan: 'free',
      credits: 0,
      purchasedCourseIds: [],
    };

    const json = JSON.stringify(bootstrapUser);
    webViewRef.current?.injectJavaScript(`
      (function() {
        try {
          localStorage.setItem('x5_user', JSON.stringify(${json}));
          localStorage.setItem('x5_credits', '0');
          window.dispatchEvent(new CustomEvent('x5NativeAuthBootstrap', { detail: ${json} }));
        } catch (_) {}
      })();
      true;
    `);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBack && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      return false;
    });
    return () => handler.remove();
  }, [canGoBack]);

  useEffect(() => {
    if (!Device.isDevice || !webReady) return;
    (async () => {
      const { status } = await Notifications.getPermissionsAsync();
      if (status !== 'granted') {
        await Notifications.requestPermissionsAsync();
      }
      const token = (await Notifications.getExpoPushTokenAsync()).data;

      webViewRef.current?.injectJavaScript(`
        window.__EXPO_PUSH_TOKEN__ = ${JSON.stringify(token)};
        true;
      `);

      if (session?.user?.id) {
        await supabase.from('profiles').update({ push_token: token }).eq('id', session.user.id);
      }
    })();
  }, [webReady, session]);

  useEffect(() => {
    if (!webReady || !session) return;
    dispatchAuthBootstrap(session);
    dispatchAuthResult({
      success: true,
      accessToken: session.access_token,
      refreshToken: session.refresh_token,
    });
  }, [session, webReady, dispatchAuthBootstrap, dispatchAuthResult]);

  useEffect(() => {
    if (!googleResponse) return;

    if (googleResponse.type === 'dismiss') {
      dispatchAuthResult({ success: false, canceled: true, provider: 'google' });
      return;
    }

    if (googleResponse.type !== 'success') {
      dispatchAuthResult({ success: false, error: 'Google sign-in failed', provider: 'google' });
      return;
    }

    const idToken = googleResponse.params.id_token;
    if (!idToken) {
      dispatchAuthResult({ success: false, error: 'Missing Google ID token', provider: 'google' });
      return;
    }

    (async () => {
      try {
        const { data, error } = await supabase.auth.signInWithIdToken({ provider: 'google', token: idToken });
        const sessionFromAuth = data.session || (await supabase.auth.getSession()).data.session;

        if (error || !sessionFromAuth) {
          dispatchAuthResult({ success: false, error: error?.message || 'Google sign-in failed', provider: 'google' });
          return;
        }

        await ensureProfile(sessionFromAuth);
        dispatchAuthBootstrap(sessionFromAuth);
        dispatchAuthResult({
          success: true,
          accessToken: sessionFromAuth.access_token,
          refreshToken: sessionFromAuth.refresh_token,
          provider: 'google',
        });
      } catch (e) {
        dispatchAuthResult({ success: false, error: (e as Error).message, provider: 'google' });
      }
    })();
  }, [googleResponse, dispatchAuthBootstrap, dispatchAuthResult]);

  const handleAppleSignIn = async () => {
    const available = await AppleAuthentication.isAvailableAsync();
    if (!available) {
      dispatchAuthResult({ success: false, error: 'Apple Sign-In not available', provider: 'apple' });
      return;
    }

    try {
      const rawNonce = Math.random().toString(36) + Date.now().toString(36);
      const hashedNonce = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        rawNonce,
      );

      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
        nonce: hashedNonce,
      });

      if (!credential.identityToken) {
        dispatchAuthResult({ success: false, error: 'No identity token', provider: 'apple' });
        return;
      }

      const { data, error } = await supabase.auth.signInWithIdToken({
        provider: 'apple',
        token: credential.identityToken,
        nonce: rawNonce,
      });

      if (error) {
        dispatchAuthResult({ success: false, error: error.message, provider: 'apple' });
        return;
      }

      const sessionFromAuth = data.session || (await supabase.auth.getSession()).data.session;
      if (!sessionFromAuth) {
        dispatchAuthResult({ success: false, error: 'Apple sign-in session not found', provider: 'apple' });
        return;
      }

      await ensureProfile(sessionFromAuth);
      dispatchAuthBootstrap(sessionFromAuth);
      dispatchAuthResult({
        success: true,
        accessToken: sessionFromAuth.access_token,
        refreshToken: sessionFromAuth.refresh_token,
        provider: 'apple',
      });
    } catch (e: unknown) {
      const code = (e as { code?: string })?.code;
      if (code === 'ERR_REQUEST_CANCELED') {
        dispatchAuthResult({ success: false, canceled: true, provider: 'apple' });
        return;
      }

      const fallback = (await supabase.auth.getSession()).data.session;
      if (fallback) {
        dispatchAuthBootstrap(fallback);
        dispatchAuthResult({
          success: true,
          accessToken: fallback.access_token,
          refreshToken: fallback.refresh_token,
          provider: 'apple',
        });
        return;
      }

      dispatchAuthResult({ success: false, error: (e as Error)?.message || code || 'UNKNOWN', provider: 'apple' });
    }
  };

  const handleGoogleSignIn = () => {
    if (!googleEnabled) {
      dispatchAuthResult({ success: false, error: 'Google Sign-In not configured', provider: 'google' });
      return;
    }

    googlePromptAsync().catch((error) => {
      dispatchAuthResult({
        success: false,
        error: (error as Error).message || 'Google sign-in failed',
        provider: 'google',
      });
    });
  };

  const handleEmailAuth = async (payload: { email: string; password: string; isSignUp?: boolean }) => {
    try {
      const { email, password, isSignUp } = payload;
      const result = isSignUp
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });

      if (result.error) throw result.error;

      const nextSession = result.data.session;
      if (!nextSession) {
        dispatchAuthResult({ success: true, confirmationRequired: true, provider: 'email' });
        return;
      }

      await ensureProfile(nextSession);
      dispatchAuthBootstrap(nextSession);
      dispatchAuthResult({
        success: true,
        accessToken: nextSession.access_token,
        refreshToken: nextSession.refresh_token,
        provider: 'email',
      });
    } catch (e) {
      dispatchAuthResult({ success: false, error: (e as Error).message, provider: 'email' });
    }
  };

  const dispatchPaymentResult = useCallback((detail: Record<string, unknown>) => {
    const json = JSON.stringify(detail);
    webViewRef.current?.injectJavaScript(`
      window.dispatchEvent(new CustomEvent('paymentResult', { detail: ${json} }));
      true;
    `);
  }, []);

  const handlePayment = async (payload: { productId: string }) => {
    const requestedProductId = payload.productId;

    try {
      const offerings = await Purchases.getOfferings();
      let pkg = offerings.current?.availablePackages[0];

      if (requestedProductId && offerings.current) {
        const matched = offerings.current.availablePackages.find(
          (candidate) => candidate.product.identifier === requestedProductId,
        );
        if (matched) pkg = matched;
      }

      if (!pkg) {
        dispatchPaymentResult({ success: false, error: 'No packages available', productId: requestedProductId });
        return;
      }

      const { customerInfo } = await Purchases.purchasePackage(pkg);
      const isActive = customerInfo.entitlements.active.pro !== undefined;
      dispatchPaymentResult({ success: true, productId: requestedProductId || pkg.product.identifier, isActive });
    } catch (e) {
      const err = e as { message?: string; userCancelled?: boolean };
      const canceled = !!err.userCancelled;
      dispatchPaymentResult({
        success: false,
        canceled,
        error: canceled ? undefined : err.message || 'Payment failed',
        productId: requestedProductId,
      });
    }
  };

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!isTrustedUrl(event.nativeEvent.url)) return;

      const msg = parseIncomingMessage(event.nativeEvent.data);
      if (!msg) return;

      switch (msg.type) {
        case 'WEB_READY':
          setWebReady(true);
          break;
        case 'LOGIN_APPLE':
          handleAppleSignIn();
          break;
        case 'LOGIN_GOOGLE':
          handleGoogleSignIn();
          break;
        case 'LOGIN_EMAIL':
          handleEmailAuth(msg.payload);
          break;
        case 'PAYMENT_REQUEST':
          handlePayment(msg.payload);
          break;
      }
    },
    [isTrustedUrl],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (request: { url: string }) => {
      if (isTrustedUrl(request.url)) return true;
      Linking.openURL(request.url).catch(() => undefined);
      return false;
    },
    [isTrustedUrl],
  );

  const injectedJS = useMemo(
    () => `
      (function() {
        window.__X5_NATIVE__ = true;
        window.__X5_PLATFORM__ = ${JSON.stringify(Platform.OS)};

        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'WEB_READY' }));
        }

        var meta = document.querySelector('meta[name=viewport]');
        if (meta) {
          meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
        }
      })();
      true;
    `,
    [],
  );

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#0A0A0F"
        translucent={Platform.OS === 'android'}
      />

      {loading && (
        <View style={styles.loader}>
          <ActivityIndicator size="large" color="#A855F7" />
        </View>
      )}

      <WebView
        ref={webViewRef}
        source={{ uri: webUrl }}
        style={styles.webview}
        injectedJavaScript={injectedJS}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
        onLoadEnd={() => setLoading(false)}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures
        originWhitelist={allowedOrigins}
        mixedContentMode="never"
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        cacheEnabled
        overScrollMode="never"
        webviewDebuggingEnabled={__DEV__}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
    paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight || 0 : 0,
  },
  webview: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0F',
    zIndex: 10,
  },
});
