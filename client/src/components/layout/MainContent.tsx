import { Outlet } from 'react-router-dom';

export default function MainContent() {
  return (
    <div className="h-full p-6">
      <Outlet />
    </div>
  );
}