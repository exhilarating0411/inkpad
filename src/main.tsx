import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { applyTheme } from './theme'
import { keepDataSafe } from './store/storage'

applyTheme()

// Ask the browser not to clear our notes when storage runs low (see store/storage.ts).
keepDataSafe()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
