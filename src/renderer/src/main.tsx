import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

try { const theme = localStorage.getItem('nexus.theme'); if (theme && theme !== 'violet') document.documentElement.dataset.theme = theme } catch { /* storage unavailable */ }

ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
