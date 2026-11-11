import { createApp } from 'vue';
import App from './App.vue';
import './styles/tokens.css';

// runtime-only：模板在构建期预编译，运行时不需要 new Function，可启用严格 CSP
createApp(App).mount('#app');
