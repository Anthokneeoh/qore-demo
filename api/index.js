require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

app.set('views', path.join(__dirname, '../views'));
app.use(express.static(path.join(__dirname, '../public')));

const apiRoutes = require('../routes/api');
const dashboardRoutes = require('../routes/dashboard');

app.use('/v1', apiRoutes);
app.use('/dashboard', dashboardRoutes);

app.get('/', (req, res) => {
    res.render('index');
});

app.use((req, res) => {
    res.status(404).json({
        type: 'https://api.qore.dev/errors/not-found',
        title: 'Not Found',
        status: 404,
        detail: `Route ${req.method} ${req.path} does not exist`,
        request_id: require('uuid').v4(),
        timestamp: new Date().toISOString()
    });
});

// Export for Vercel
module.exports = app;

// Local development only
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => console.log(`Qore Demo running on http://localhost:${PORT}`));
}