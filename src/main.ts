import Vue from 'vue';
import { BrowserDetection } from '@nimiq/utils';
import App from './App.vue';
import router from './router';
import store from './store';
import staticStore from '@/lib/StaticStore';
import RpcApi from '@/lib/RpcApi';
import VueRaven from 'vue-raven'; // Sentry.io SDK

if (window.hasBrowserWarning) {
    throw new Error('Exeution aborted due to browser warning');
}

if (BrowserDetection.isIOS() || BrowserDetection.isSafari()) {
    // Register service worker to strip cookie from requests
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/ServiceWorker.js', {
            scope: '/',
        }).then((reg) => {
            console.debug(`Service worker has been registered for scope: ${reg.scope}`);
        }).catch((error) => {
            console.warn(`Service worker installation failed`);
            throw error;
        });
    }
}

Vue.config.productionTip = false;

// Set up Identicon SVG file path
// FIXME Need to find a better method to automatically detect this
// @ts-ignore
self.NIMIQ_IQONS_SVG_PATH = '/img/iqons.min.72f3b689.svg';

const rpcApi = new RpcApi(store, staticStore, router);
Vue.prototype.$rpc = rpcApi; // rpcApi is started in App.vue->created()

if (window.location.origin === 'https://accounts.nimiq-testnet.com') {
  Vue.use(VueRaven, {
    dsn: 'https://92f2289fc2ac4c809dfa685911f865c2@sentry.io/1330855',
  });
}

new Vue({
  router,
  store,
  render: (h) => h(App),
}).$mount('#app');

// Types
declare module 'vue/types/vue' {
  interface Vue {
    $rpc: RpcApi;
  }
}
