# Demand Forecasting Modes

The Admin dashboard at `/admin/demand-forecasting` has two explicit history modes.

- **Real Data Mode** reads request creation times from MongoDB. It forecasts only when a full 168-hour window is covered by recorded data. It does not fill history before the first recorded request.
- **Synthetic Demo Mode** reads the last 168 continuous hourly counts from `ml/demand_forecasting/data/synthetic_hourly_demand.csv` through the Node backend. It does not create dispatch records and is never substituted for Real Data Mode.

Both modes use the authenticated Node endpoint `POST /api/demand-forecasting/forecast`; the browser never calls FastAPI directly. The request includes the selected mode, forecast start timestamp, horizon (24, 72, or 168 hours), and exactly 168 history counts. Before calling FastAPI, the backend checks that the submitted history matches the selected source.

The page displays a persistent mode-specific warning. Synthetic Demo Mode uses generated history and predictions that do not represent actual SWERV demand. The model was also trained on synthetic data, so neither mode establishes real-world forecasting accuracy. The demo starts at the hour immediately after the final timestamp in the bundled CSV.
