const bcrypt = require('bcrypt')
const cookieParser = require('cookie-parser')
const cors = require('cors')
const express = require('express')
const session = require('express-session')
const path = require('path')
const config = require('./config')
const {
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client,
} = require('@aws-sdk/client-s3')
const {getSignedUrl} = require('@aws-sdk/s3-request-presigner')
const axios = require('axios')
const {PrismaClient} = require('@prisma/client')

// Better variable naming
const prismaDB = new PrismaClient()
const awsS3Client = new S3Client({
	credentials: {
		accessKeyId: config.aws_access_key_id,
		secretAccessKey: config.aws_secret_access_key,
	},
	region: config.region,
})

const app = express()

// Middleware configurations
app.use(cors())
app.use(cookieParser())
app.use(
	session({
		secret: config.session_secret,
		resave: false,
		saveUninitialized: false,
		cookie: {
			maxAge: 60 * 60 * 1000,
		},
	})
)
app.use(express.urlencoded({extended: true}))
app.use(express.json())
app.use(express.static(path.join(__dirname, 'view')))
app.use((req, _, next) => {
	req.session.userId = req.session.userId || undefined
	next()
})

// Routes
app.get('/', handleRootRequest)
app.get('/login', handleLoginGetRequest)
app.post('/login', handleLoginPostRequest)
app.post('/logout', handleLogoutRequest)
app.get('/s3-presigned-url', handlePresignedUrlRequest)
app.post('/share', handleFileCreationRequest)
app.get('/access', handleFileAccessRequest)
app.get('*', handleNotFoundRequest)

// Route Handlers
async function handleRootRequest(req, res) {
	if (req.session && req.session.userId) {
		res.sendFile(path.join(__dirname, 'view', 'upload.html'))
	} else {
		res.redirect('/login')
	}
}

async function handleLoginGetRequest(_, res) {
	res.sendFile(path.join(__dirname, 'view', 'login.html'))
}

async function handleLoginPostRequest(req, res) {
	const {email, password} = req.body
	if (!email || !password) {
		return res.status(400).json({
			success: false,
			error: 'Missing email or password',
		})
	}
	const user = await prismaDB.user.findUnique({where: {email}})
	if (!user) {
		return res
			.status(400)
			.json({success: false, emailError: 'No user found with this email'})
	}
	const isValidPassword = await bcrypt.compare(password, user.password)
	if (!isValidPassword) {
		return res
			.status(400)
			.json({success: false, passwordError: 'Invalid password'})
	}
	req.session.userId = user.id
	res.status(200).json({success: true})
}

async function handleLogoutRequest(req, res) {
	req.session.userId = undefined
	res.status(200).json({success: true})
}

async function handlePresignedUrlRequest(req, res) {
	const {key} = req.query
	if (!key) return res.status(400).json({error: 'No key provided'})
	const encodedKey = encodeURIComponent(key)
	const url = await getSignedUrl(
		awsS3Client,
		new PutObjectCommand({Bucket: config.bucket_name, Key: encodedKey}),
		{expiresIn: 60}
	)
	return res.status(200).json({url})
}

async function handleFileCreationRequest(req, res) {
	const userId = req.session.userId
	const key = req.body.key
	const emails = req.body.emails
	if (!userId) {
		return res.status(400).json({error: 'No user found'})
	}
	if (!emails || emails.length === 0) {
		return res.status(400).json({error: 'No email provided'})
	}
	if (!key) {
		return res.status(400).json({error: 'No key provided'})
	}
	const url = `https://${config.bucket_name}.s3.${config.region}.amazonaws.com/${key}`
	const file = await prismaDB.file.create({
		data: {
			url: url,
			userId: userId,
			sharedWith: {
				createMany: {
					data: emails.map(email => ({
						email: email,
						token: Math.random().toString(36).slice(2),
					})),
				},
			},
		},
		include: {
			sharedWith: true,
		},
	})
	// Sending file to recipients
	for (const recipient of file.sharedWith) {
		try {
			await axios.post(
				'https://jullr2d6zs3smqpitohw2ladyu0lzzvo.lambda-url.us-west-2.on.aws',
				{
					to: recipient.email,
					subject: 'New file!',
					text: `${config.server_url}/access?token=${recipient.token}`,
					html: `<a href="${config.server_url}/access?token=${recipient.token}">this link</a>`,
				},
				{method: 'POST'}
			)
			return res.status(200).json({success: true})
		} catch (error) {
			console.error(error)
			return res.status(400).json({error: 'Error sending email'})
		}
	}
}

async function handleFileAccessRequest(req, res) {
	const token = req.query.token

	if (!token) {
		return res.status(400).json({error: 'No token provided'})
	}

	const user = await prismaDB.sharedRecipient.findFirst({
		where: {
			token,
		},
		include: {
			file: {
				include: {
					_count: true,
				},
			},
		},
	})

	if (!user) {
		return res.status(400).json({
			error: 'No recipients found',
		})
	}

	const isFileAccessedByAll =
		user.file._count.sharedWith === user.file._count.accessedBy

	if (isFileAccessedByAll) {
		await awsS3Client.send(
			new DeleteObjectCommand({
				Key: user.file.url.split('/').pop(),
				Bucket: config.bucket_name,
			})
		)

		return res.status(404).json({
			error: 'File has been deleted',
		})
	}

	await prismaDB.fileAccess.upsert({
		where: {
			email_fileId: {
				email: user.email,
				fileId: user.fileId,
			},
		},
		create: {
			fileId: user.fileId,
			email: user.email,
		},
		update: {},
	})

	return res.redirect(user.file.url)
}

async function handleNotFoundRequest(_, res) {
	res.status(404).send('404 Not Found')
}

const serverPort = config.port
app.listen(serverPort, () => {
	console.log(
		`Server is listening on port ${serverPort}\nYou can access via http://localhost:${serverPort}/`
	)
})
