import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { isLanguageChoice, resolveLanguage, setLanguage } from './lib/i18n'
import { readSetting } from './lib/settings'
import './styles.css'

// Resolve what can be known synchronously (the stored choice, else the webview locale)
// before the first paint; App refines this once the CLI payload arrives with `lang`.
const stored = readSetting('language')
setLanguage(resolveLanguage({ chosen: isLanguageChoice(stored) ? stored : null }))

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
