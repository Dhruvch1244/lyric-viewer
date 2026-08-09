/**
 * Custom entry point, replacing package.json's default
 * "main": "expo/AppEntry.js". That file imports App via a relative path
 * ('../../App') that assumes the classic single-project layout
 * (node_modules/expo/AppEntry.js -> ../../App at the project root) — in an
 * npm workspaces monorepo, `expo` gets hoisted to the workspace root's
 * node_modules while App.tsx lives in packages/mobile, so that relative
 * path resolves to the wrong place ("Unable to resolve module ../../App").
 * Importing App relative to this file instead sidesteps the assumption
 * entirely, regardless of where npm hoists `expo` to.
 */

import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
