import { Route, Routes } from 'react-router';
import Layout from './components/Layout';
import About from './pages/About';
import NotFound from './pages/NotFound';
import Welcome from './pages/Welcome';

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/about" element={<About />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
