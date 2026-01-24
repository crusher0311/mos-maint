const apiResponse = require("../helpers/apiResponse");
const axios = require("axios");
const UserModel = require("../model/user");
const LogoModel = require("../model/uploadedLogo");
const { constants } = require("../helpers/constants");
require("dotenv").config();

const updateHoverCodeWithAxios = async (userData, logo) => {
    try {
        if (logo == null) {
            logo = await LogoModel.findOne({ user_id: "660a7ca946ec6e2fe4c1c3f4" }); // get admin logo
        }

        const data = {
            "workspace": process.env.HOVERCODE_WORKSPACE_ID,
            "logo_url": process.env.HOVERCOE_LOGO_PREFIX + 'appointment.png',
            "qr_data": userData?.targetSchedule ? userData.targetSchedule : 'https://app.myoilsticker.com',
            "display_name": userData ? userData.targetPhone : '',
            "qr_type": "Link",
            "pattern": "Squares",
            "dynamic": true,
            "generate_png": true,
            "background_color": constants.STICKER_DEFAULT_BGCOLOR
        };

        let config = {
            method: userData.hovercode ? "put" : "post",
            maxBodyLength: Infinity,
            url: userData.hovercode ? process.env.HOVERCODE_API_URL + "/" + userData.hovercode + "/update" : process.env.HOVERCODE_API_URL + "/create",
            headers: {
                "Authorization": process.env.HOVERCODE_API_KEY
            },
            data: data
        };

        let resp = await axios.request(config);
        let hoverCodeInfo = resp.data;

        await UserModel.findByIdAndUpdate(userData._id, { hovercode: hoverCodeInfo.id });

        return hoverCodeInfo;
    } catch (e) {
        console.log(e);
        return null;
    }
}

const updateQRCode = async (req, res) => {
    try {
        const user = req.user;

        let userData = await UserModel.findById(user.id);
        if (!userData) {
            return apiResponse.validationErrorWithData(res, "No User");
        }

        let logo = await LogoModel.findOne({ user_id: user.id, defaultFlag: true });

        updateHoverCodeWithAxios(userData, logo);

        return apiResponse.successResponse(res, "ok");
    } catch (e) {
        console.log(e);
        return apiResponse.ErrorResponse(res, "Internal Server Error.");
    }
}

const downloadImageWithStream = async (req, res) => {
    try {
        console.log(req.param)
        const imageUrl = req.query.url;
        const response = await axios({
            url: imageUrl,
            method: 'GET',
            responseType: 'stream'
        });

        // Set the appropriate headers on the response
        res.setHeader('Content-Type', response.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000');

        // Pipe the image data to the response
        response.data.pipe(res);
    } catch (error) {
        console.error('Error fetching the image:', error);
        res.status(500).send('Error fetching the image');
    }
}

const getQRCodeWithID = async (req, res) => {
    try {
        const user = req.user;

        let userData = await UserModel.findById(user.id);
        if (!userData) {
            return apiResponse.validationErrorWithData(res, "No User");
        }
        let hoverCode = userData.hovercode;

        if (!hoverCode) {
            console.log("No hover code. Generate it.");
            let logo = await LogoModel.findOne({ user_id: user.id, defaultFlag: true });

            let hoverCodeInfo = await updateHoverCodeWithAxios(userData, logo);

            hoverCode = hoverCodeInfo.id;
            if (!hoverCode) {
                throw new Error("Failed to create hover code.");
            }
        }

        let hover_config = {
            method: "get",
            maxBodyLength: Infinity,
            url: process.env.HOVERCODE_API_URL + "/" + hoverCode,
            headers: {
                "Authorization": process.env.HOVERCODE_API_KEY
            },
        }

        let resp = await axios.request(hover_config);
        let hoverCodeInfo = resp.data;

        return apiResponse.successResponseWithData(res, "success", { qr_url: hoverCodeInfo.svg_file });
    } catch (e) {
        console.log(e);
        return apiResponse.ErrorResponse(res, "Internal Server Error.");

    }
}

const getAllofQRCodes = async (req, res) => {
    return apiResponse.successResponse(res, "ok");
}

module.exports = {
    updateHoverCodeWithAxios,
    updateQRCode,
    downloadImageWithStream,
    getQRCodeWithID,
    getAllofQRCodes
}