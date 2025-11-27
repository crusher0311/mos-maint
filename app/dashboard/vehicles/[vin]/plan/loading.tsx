export default function PlanLoading() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full mx-4">
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-6">
            <div className="w-16 h-16 border-4 border-blue-200 rounded-full"></div>
            <div className="w-16 h-16 border-4 border-blue-600 rounded-full border-t-transparent animate-spin absolute top-0 left-0"></div>
          </div>
          
          <h2 className="text-xl font-semibold text-gray-800 mb-2">
            Building Your Maintenance Plan
          </h2>
          
          <p className="text-gray-500 mb-6">
            Searching history, schedules, inspections...
          </p>
          
          <div className="w-full space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-blue-600 rounded-full animate-pulse"></div>
              <span className="text-sm text-gray-600">Checking OEM maintenance schedules</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" style={{ animationDelay: '0.2s' }}></div>
              <span className="text-sm text-gray-600">Reviewing inspection findings</span>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 bg-purple-500 rounded-full animate-pulse" style={{ animationDelay: '0.4s' }}></div>
              <span className="text-sm text-gray-600">Analyzing service history</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
