export default function Home() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    () => JSON.parse(localStorage.getItem('sidebarOpen') ?? 'true')
  );

  // Persist state
  useEffect(() => {
    localStorage.setItem('sidebarOpen', JSON.stringify(isSidebarOpen));
  }, [isSidebarOpen]);

  return (
    <div className="flex h-screen">
      {/* Toggle button on the far left */}
      <button
        aria-label="Toggle sidebar"
        onClick={() => setIsSidebarOpen(prev => !prev)}
        className="p-2 hover:bg-gray-200"
      >
        {isSidebarOpen ? '←' : '→'}
      </button>

      {/* Sidebar – only rendered when open */}
      {isSidebarOpen && <Sidebar className="w-64" />}

      {/* Main content takes remaining space */}
      <main className="flex-1 overflow-auto">
        <ChatArea />
        {/* …other panels… */}
      </main>
    </div>
  );
}