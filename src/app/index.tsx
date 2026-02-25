import { useRef, useCallback, useEffect, useState, useMemo } from 'react';
import {
  View,
  StyleSheet,
  Platform,
  BackHandler,
  ActivityIndicator,
  StatusBar,
  Linking,
  Text,
  Image,
  AppState,
} from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import Purchases from 'react-native-purchases';
import type { Session } from '@supabase/supabase-js';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../services/supabase';

WebBrowser.maybeCompleteAuthSession();

const normalizeUrl = (value: string) => value.replace(/\/$/, '');
const PROD_WEB_URL = normalizeUrl(process.env.EXPO_PUBLIC_WEB_URL || 'https://x5marketing.com');
const DEV_WEB_URL = normalizeUrl(process.env.EXPO_PUBLIC_WEB_URL_DEV || PROD_WEB_URL);
const INITIAL_WEB_URL = __DEV__ ? DEV_WEB_URL : PROD_WEB_URL;

const ALLOWED_MESSAGE_TYPES = new Set([
  'WEB_READY',
  'LOGIN_APPLE',
  'LOGIN_GOOGLE',
  'LOGIN_EMAIL',
  'PAYMENT_REQUEST',
]);
const ALLOWED_PRODUCT_IDS = new Set(['x5_pro_monthly', 'x5_pro_yearly', 'x5_credits_1000']);
const PURCHASE_TX_CACHE_KEY_PREFIX = 'x5_rc_tx_cache_v1:';
const MAX_TRACKED_TRANSACTIONS = 150;

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

const isGoogleRequestStillLoadingError = (error: unknown): boolean => {
  const msg = (error as Error)?.message?.toLowerCase() || '';
  return (
    msg.includes('cannot prompt to authenticate') ||
    msg.includes('not finished loading') ||
    msg.includes('until the request has finished loading') ||
    (msg.includes('request') && msg.includes('finished loading'))
  );
};

const isGooglePromptInProgressError = (error: unknown): boolean => {
  const msg = (error as Error)?.message?.toLowerCase() || '';
  return (
    msg.includes('already in progress') ||
    msg.includes('another prompt') ||
    msg.includes('authentication is already in progress')
  );
};

const markTransactionIfNew = async (userId: string, transactionId: string): Promise<boolean> => {
  const key = `${PURCHASE_TX_CACHE_KEY_PREFIX}${userId}`;

  try {
    const raw = await AsyncStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    const txList: string[] = Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];

    if (txList.includes(transactionId)) return false;

    const next = [transactionId, ...txList].slice(0, MAX_TRACKED_TRANSACTIONS);
    await AsyncStorage.setItem(key, JSON.stringify(next));
    return true;
  } catch (error) {
    // Fail-open: allow purchase rather than block user. Server-side idempotency is the real safeguard.
    console.error('[Payment] Transaction dedup cache error:', transactionId, error);
    return true;
  }
};

/** Insert profile row if it doesn't exist (ON CONFLICT DO NOTHING — never overwrites). */
const ensureProfile = async (session: Session) => {
  const user = session.user;
  const { error } = await supabase.from('profiles').upsert(
    {
      id: user.id,
      name: user.user_metadata?.full_name || user.user_metadata?.name || 'User',
      email: user.email,
      plan: 'free',
      credits: 50,
    },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (error) console.error('[Profile] Failed to ensure profile:', error.message);
};

export default function MainScreen() {
  const webViewRef = useRef<WebView>(null);
  const [canGoBack, setCanGoBack] = useState(false);
  const [webReady, setWebReady] = useState(false);
  const webReadyRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [activeWebUrl, setActiveWebUrl] = useState(() => INITIAL_WEB_URL);
  const [webVersion, setWebVersion] = useState(() => Date.now());
  const [googleAuthPending, setGoogleAuthPending] = useState(false);
  const googleAuthPendingRef = useRef(false);
  const googlePromptInFlightRef = useRef(false);
  const paymentInFlightRef = useRef(false);
  const prodFallbackAttemptedRef = useRef(false);
  const { session } = useAuth();
  const launchStartedAtRef = useRef(Date.now());
  const lastWebRefreshAtRef = useRef(Date.now());

  const webLaunchUrl = useMemo(() => {
    const separator = activeWebUrl.includes('?') ? '&' : '?';
    return `${activeWebUrl}${separator}native=1&t=${webVersion}`;
  }, [activeWebUrl, webVersion]);

  const allowedOrigins = useMemo(() => {
    const base = [PROD_WEB_URL, DEV_WEB_URL, 'http://localhost:5176'];
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
  const isExpoGo = Constants.executionEnvironment === 'storeClient';
  const googleClientId = isExpoGo
    ? googleWebClientId
    : Platform.OS === 'ios'
      ? googleIosClientId
      : googleAndroidClientId;
  const googleRedirectUri = useMemo(() => {
    if (!isExpoGo) return undefined;
    try {
      return AuthSession.getRedirectUrl();
    } catch {
      return undefined;
    }
  }, [isExpoGo]);
  const googleEnabled = !!googleClientId;

  const [googleRequest, googleResponse, googlePromptAsync] = Google.useIdTokenAuthRequest({
    clientId: googleClientId || 'placeholder.apps.googleusercontent.com',
    iosClientId: isExpoGo ? undefined : googleIosClientId || 'placeholder.apps.googleusercontent.com',
    androidClientId: isExpoGo ? undefined : googleAndroidClientId || 'placeholder.apps.googleusercontent.com',
    webClientId: googleWebClientId || 'placeholder.apps.googleusercontent.com',
    redirectUri: googleRedirectUri,
  });
  const googleRequestReady = !!googleRequest?.url;

  const dispatchAuthResult = useCallback((detail: NativeAuthResult) => {
    const json = JSON.stringify(detail);
    const isApple = detail.provider === 'apple';
    webViewRef.current?.injectJavaScript(`
      window.dispatchEvent(new CustomEvent('nativeAuthResult', { detail: ${json} }));
      ${isApple ? `window.dispatchEvent(new CustomEvent('appleSignInResult', { detail: ${json} }));` : ''}
      true;
    `);
  }, []);

  useEffect(() => {
    googleAuthPendingRef.current = googleAuthPending;
    if (!googleAuthPending) return;

    let interval: ReturnType<typeof setInterval> | undefined;

    const attempt = () => {
      if (!googleRequestReady) return; // still loading, wait for next interval
      if (googlePromptInFlightRef.current) return;
      if (interval) clearInterval(interval);
      interval = undefined;
      setGoogleAuthPending(false);
      googleAuthPendingRef.current = false;
      googlePromptInFlightRef.current = true;
      googlePromptAsync().catch((error: unknown) => {
        const msg = (error as Error)?.message || '';
        if (isGoogleRequestStillLoadingError(error)) {
          // Still not ready — re-arm pending.
          setGoogleAuthPending(true);
          googleAuthPendingRef.current = true;
          return;
        }
        if (isGooglePromptInProgressError(error)) {
          return;
        }
        dispatchAuthResult({
          success: false,
          error: msg || 'Google sign-in failed',
          provider: 'google',
        });
      }).finally(() => {
        googlePromptInFlightRef.current = false;
      });
    };

    // Create interval first, then try immediately.
    interval = setInterval(attempt, 300);
    attempt();

    const timeout = setTimeout(() => {
      if (interval) clearInterval(interval);
      if (googleAuthPendingRef.current) {
        setGoogleAuthPending(false);
        googleAuthPendingRef.current = false;
        dispatchAuthResult({
          success: false,
          error: 'Google Sign-In took too long to initialize',
          provider: 'google',
        });
      }
    }, 15000);

    return () => {
      if (interval) clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [googleAuthPending, googleRequestReady, googlePromptAsync, dispatchAuthResult]);

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
        } catch (e) {
          console.error('[X5 Native] Failed to persist auth to localStorage:', e);
        }
        window.dispatchEvent(new CustomEvent('x5NativeAuthBootstrap', { detail: ${json} }));
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
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') return;
      const now = Date.now();
      // Refresh web shell on return from background to reduce stale UI issues.
      if (now - lastWebRefreshAtRef.current > 15 * 60 * 1000) {
        webReadyRef.current = false;
        setWebReady(false);
        setLoading(true);
        launchStartedAtRef.current = now;
        setWebVersion(now);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    // Never keep startup splash forever when web content is unreachable.
    const timeout = setTimeout(() => {
      if (!webReadyRef.current) {
        setLoading(false);
      }
    }, 12000);
    return () => clearTimeout(timeout);
  }, [webVersion, activeWebUrl]);

  useEffect(() => {
    if (!Device.isDevice || !webReady) return;
    (async () => {
      try {
        const { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') {
          const { status: newStatus } = await Notifications.requestPermissionsAsync();
          if (newStatus !== 'granted') return;
        }
        const token = (await Notifications.getExpoPushTokenAsync()).data;

        webViewRef.current?.injectJavaScript(`
          window.__EXPO_PUSH_TOKEN__ = ${JSON.stringify(token)};
          true;
        `);

        if (session?.user?.id) {
          const { error } = await supabase.from('profiles').update({ push_token: token }).eq('id', session.user.id);
          if (error) console.error('[Notifications] Failed to save push token:', error.message);
        }
      } catch (error) {
        console.error('[Notifications] Push setup failed:', error);
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
    googlePromptInFlightRef.current = false;
    setGoogleAuthPending(false);
    googleAuthPendingRef.current = false;

    if (googleResponse.type === 'dismiss') {
      dispatchAuthResult({ success: false, canceled: true, provider: 'google' });
      return;
    }

    if (googleResponse.type !== 'success') {
      const details =
        ('params' in googleResponse && (googleResponse.params?.error_description || googleResponse.params?.error)) ||
        ('error' in googleResponse && googleResponse.error?.message) ||
        'Google sign-in failed';
      dispatchAuthResult({ success: false, error: String(details), provider: 'google' });
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
        dispatchAuthResult({ success: false, error: (e as Error)?.message || 'Google sign-in failed', provider: 'google' });
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
      const randomBytes = await Crypto.getRandomBytesAsync(32);
      const rawNonce = Array.from(randomBytes, (b) => b.toString(16).padStart(2, '0')).join('');
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

      console.error('[Apple Sign-In] Failed:', (e as Error)?.message || code, e);

      const fallback = (await supabase.auth.getSession()).data.session;
      if (fallback) {
        console.warn('[Apple Sign-In] Using pre-existing session as fallback');
        dispatchAuthBootstrap(fallback);
        dispatchAuthResult({
          success: true,
          accessToken: fallback.access_token,
          refreshToken: fallback.refresh_token,
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
    if (googlePromptInFlightRef.current) {
      return;
    }

    // Request may still be initializing right after app/webview load.
    // googleRequest exists but may not be ready yet — defer until it is.
    if (!googleRequestReady) {
      setGoogleAuthPending(true);
      return;
    }

    // Wrap in try/catch to handle "request not finished loading" race condition.
    try {
      googlePromptInFlightRef.current = true;
      googlePromptAsync().catch((error: unknown) => {
        // If request wasn't ready, retry via pending flag.
        if (isGoogleRequestStillLoadingError(error)) {
          setGoogleAuthPending(true);
          return;
        }
        if (isGooglePromptInProgressError(error)) {
          return;
        }
        dispatchAuthResult({
          success: false,
          error: (error as Error).message || 'Google sign-in failed',
          provider: 'google',
        });
      }).finally(() => {
        googlePromptInFlightRef.current = false;
      });
    } catch (error) {
      // Synchronous throw — request not ready, defer.
      googlePromptInFlightRef.current = false;
      setGoogleAuthPending(true);
    }
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
    if (paymentInFlightRef.current) {
      dispatchPaymentResult({
        success: false,
        error: 'Payment is already in progress',
        productId: requestedProductId,
      });
      return;
    }

    paymentInFlightRef.current = true;
    try {
      const finalizePurchase = async (params: {
        purchasedProductId: string;
        transactionId?: string;
        customerInfo: { entitlements: { active: Record<string, unknown> } };
      }) => {
        const { purchasedProductId, transactionId, customerInfo } = params;

        if (requestedProductId && purchasedProductId !== requestedProductId) {
          dispatchPaymentResult({
            success: false,
            error: `Purchased product mismatch: expected ${requestedProductId}, got ${purchasedProductId}`,
            productId: requestedProductId,
            purchasedProductId,
          });
          return;
        }

        const mustHaveTransaction = purchasedProductId === 'x5_credits_1000';
        if (mustHaveTransaction && !transactionId) {
          dispatchPaymentResult({
            success: false,
            error: 'Missing transaction ID for credits purchase',
            productId: requestedProductId || purchasedProductId,
            purchasedProductId,
          });
          return;
        }

        if (transactionId) {
          const userId = session?.user?.id || 'anon';
          const isNewTransaction = await markTransactionIfNew(userId, transactionId);
          if (!isNewTransaction) {
            dispatchPaymentResult({
              success: false,
              error: 'This purchase was already processed',
              alreadyProcessed: true,
              productId: requestedProductId || purchasedProductId,
              purchasedProductId,
              transactionId,
            });
            return;
          }
        }

        const isActive = customerInfo.entitlements.active.pro !== undefined;
        dispatchPaymentResult({
          success: true,
          productId: requestedProductId || purchasedProductId,
          purchasedProductId,
          transactionId,
          isActive,
        });
      };

      const offerings = await Purchases.getOfferings();
      let pkg = offerings.current?.availablePackages[0];

      if (requestedProductId && offerings.current) {
        const matched = offerings.current.availablePackages.find(
          (candidate) => candidate.product.identifier === requestedProductId,
        );
        if (matched) pkg = matched;
      }

      if (pkg) {
        const purchase = await Purchases.purchasePackage(pkg);
        await finalizePurchase({
          purchasedProductId: purchase.productIdentifier || pkg.product.identifier,
          transactionId: purchase.transaction?.transactionIdentifier,
          customerInfo: purchase.customerInfo,
        });
        return;
      }

      // Fallback path: purchase by product ID when offerings are temporarily empty/misconfigured.
      const productIds = requestedProductId ? [requestedProductId] : Array.from(ALLOWED_PRODUCT_IDS);
      const products = await Purchases.getProducts(productIds);
      const product = requestedProductId
        ? products.find((candidate) => candidate.identifier === requestedProductId)
        : products[0];

      if (!product) {
        dispatchPaymentResult({
          success: false,
          error: 'No products available in RevenueCat',
          productId: requestedProductId,
        });
        return;
      }

      const purchase = await Purchases.purchaseStoreProduct(product);
      await finalizePurchase({
        purchasedProductId: purchase.productIdentifier || product.identifier,
        transactionId: purchase.transaction?.transactionIdentifier,
        customerInfo: purchase.customerInfo,
      });
    } catch (e) {
      const err = e as { message?: string; userCancelled?: boolean };
      const canceled = !!err.userCancelled;
      const normalizedMessage =
        !canceled && err.message?.toLowerCase().includes('offerings')
          ? 'RevenueCat offerings are not configured'
          : err.message || 'Payment failed';
      dispatchPaymentResult({
        success: false,
        canceled,
        error: canceled ? undefined : normalizedMessage,
        productId: requestedProductId,
      });
    } finally {
      paymentInFlightRef.current = false;
    }
  };

  // Use refs to avoid stale closures in onMessage — handlers reference
  // googleRequest and other values that change between renders.
  const handleAppleSignInRef = useRef(handleAppleSignIn);
  handleAppleSignInRef.current = handleAppleSignIn;
  const handleGoogleSignInRef = useRef(handleGoogleSignIn);
  handleGoogleSignInRef.current = handleGoogleSignIn;
  const handleEmailAuthRef = useRef(handleEmailAuth);
  handleEmailAuthRef.current = handleEmailAuth;
  const handlePaymentRef = useRef(handlePayment);
  handlePaymentRef.current = handlePayment;

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!isTrustedUrl(event.nativeEvent.url)) return;

      const msg = parseIncomingMessage(event.nativeEvent.data);
      if (!msg) return;

      switch (msg.type) {
        case 'WEB_READY':
          webReadyRef.current = true;
          setWebReady(true);
          // Keep splash visible briefly for smooth startup and avoid flash/flicker.
          setTimeout(() => {
            const minVisibleMs = 900;
            const elapsed = Date.now() - launchStartedAtRef.current;
            const delay = Math.max(0, minVisibleMs - elapsed);
            setTimeout(() => setLoading(false), delay);
          }, 0);
          break;
        case 'LOGIN_APPLE':
          handleAppleSignInRef.current();
          break;
        case 'LOGIN_GOOGLE':
          handleGoogleSignInRef.current();
          break;
        case 'LOGIN_EMAIL':
          handleEmailAuthRef.current(msg.payload);
          break;
        case 'PAYMENT_REQUEST':
          handlePaymentRef.current(msg.payload);
          break;
      }
    },
    [isTrustedUrl],
  );

  const onShouldStartLoadWithRequest = useCallback(
    (request: { url: string }) => {
      if (isTrustedUrl(request.url)) return true;
      Linking.openURL(request.url).catch((err) => console.warn('[Linking] Failed to open:', request.url, err?.message));
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

      <WebView
        ref={webViewRef}
        source={{ uri: webLaunchUrl }}
        style={styles.webview}
        injectedJavaScript={injectedJS}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onNavigationStateChange={(nav) => setCanGoBack(nav.canGoBack)}
        onLoadEnd={() => {
          lastWebRefreshAtRef.current = Date.now();
          // Fallback if WEB_READY did not arrive for any reason.
          setTimeout(() => {
            setLoading(false);
          }, 2500);
        }}
        onError={() => {
          if (__DEV__ && activeWebUrl !== PROD_WEB_URL && !prodFallbackAttemptedRef.current) {
            // Expo Go often runs without local web server; fallback to production web URL once.
            prodFallbackAttemptedRef.current = true;
            webReadyRef.current = false;
            setWebReady(false);
            setLoading(true);
            launchStartedAtRef.current = Date.now();
            setActiveWebUrl(PROD_WEB_URL);
            setWebVersion(Date.now());
            return;
          }
          setLoading(false);
        }}
        javaScriptEnabled
        domStorageEnabled
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        allowsBackForwardNavigationGestures
        originWhitelist={allowedOrigins}
        mixedContentMode="never"
        sharedCookiesEnabled
        thirdPartyCookiesEnabled
        cacheEnabled={false}
        overScrollMode="never"
        webviewDebuggingEnabled={__DEV__}
      />

      {loading && (
        <View style={styles.splashOverlay}>
          <Image
            source={require('../../assets/icon.png')}
            style={styles.splashIcon}
            resizeMode="contain"
          />
          <Text style={styles.splashTitle}>X5 Marketing</Text>
          <ActivityIndicator size="small" color="#3B82F6" style={styles.splashSpinner} />
        </View>
      )}
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
  splashOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 30,
  },
  splashIcon: {
    width: 160,
    height: 160,
    marginBottom: 12,
  },
  splashTitle: {
    color: '#1A1A1A',
    fontSize: 18,
    fontWeight: '600',
    marginTop: 4,
  },
  splashSpinner: {
    marginTop: 20,
  },
});
