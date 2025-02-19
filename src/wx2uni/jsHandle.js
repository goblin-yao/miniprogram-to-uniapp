/*
 *
 * 处理js文件
 * 
 */
const t = require('@babel/types');
const nodePath = require('path');
const parse = require('@babel/parser').parse;
const generate = require('@babel/generator').default;
const traverse = require('@babel/traverse').default;
const template = require('@babel/template').default;
const JavascriptParser = require('./js/JavascriptParser');
const componentConverter = require('./js/componentConverter');
const clone = require('clone');

const utils = require('../utils/utils.js');
const pathUtil = require('../utils/pathUtil.js');
const babelUtil = require('../utils/babelUtil.js');

/**
 * 将ast属性数组组合为ast对象
 * @param {*} pathAry 
 */
function arrayToObject(pathAry) {
	return t.objectExpression(pathAry);
}

/**
 * 子页面/组件的模板
 */
const componentTemplate =
	`
export default {
  data() {
    return DATA
  },
  components: {},
  props:PROPS,
  methods: METHODS,
  computed: COMPUTED,
  watch:WATCH,
}
`;

/**
 * App页面的模板
 */
const componentTemplateApp =
	`
export default {
	methods: METHODS,
}
`;

/**
 * 生成"let = right;"表达式
 * @param {*} left 
 * @param {*} right 
 */
function buildAssignment(left, right) {
	return t.assignmentExpression("=", left, right);
}

/**
 * 生成"this.left = right;"表达式
 * @param {*} left 
 * @param {*} right 
 */
function buildAssignmentWidthThis(left, right) {
	return t.assignmentExpression("=", t.memberExpression(t.thisExpression(), left), right);
}

/**
 * 生成"that.left = right;"  //后面有需求再考虑其他关键字
 * @param {*} left 
 * @param {*} right 
 */
function buildAssignmentWidthThat(left, right, name) {
	return t.assignmentExpression("=", t.memberExpression(t.identifier(name), left), right);
}

/**
 * 处理this.setData -- 已弃用
 * @param {*} path 
 * @param {*} isThis 区分前缀是this，还是that
 */
function handleSetData(path, isThis) {
	let parent = path.parent;
	let nodeArr = [];
	if (parent.arguments) {
		parent.arguments.forEach(function (obj) {
			if (obj.properties) {
				obj.properties.forEach(function (item) {
					let left = item.key;
					//有可能key是字符串形式的
					if (t.isStringLiteral(left)) left = t.identifier(left.value);
					//
					let node = null;
					if (isThis) {
						node = t.expressionStatement(buildAssignmentWidthThis(left, item.value));
					} else {
						let object = path.get('object');
						node = t.expressionStatement(buildAssignmentWidthThat(left, item.value, object.node.name));
					}

					nodeArr.push(node);
				});
			}
		});
		if (nodeArr.length > 0) {
			//将this.setData({})进行替换
			//!!!!!!!!这里找父级使用递归查找，有可能path的上一级会是CallExpression!!!!!
			parent = path.findParent((parent) => parent.isExpressionStatement())
			if (parent) {
				parent.replaceWithMultiple(nodeArr);
			} else {
				console.log(`异常-->代码为：${generate(path.node).code}`);
			}
		}
	}
}

/**
 * 获取setData()的AST
 * 暂未想到其他好的方式来实现将setData插入到methods里。
 */
var setDataFunAST = null;
function getSetDataFunAST() {
	if (setDataFunAST) return clone(setDataFunAST);
	const code = `
	var setData = {
	setData:function(obj){  
		let that = this;  
		let keys = [];  
		let val,data;  
		Object.keys(obj).forEach(function(key){  
				keys = key.split('.');  
				val = obj[key];  
				data = that.$data;  
				keys.forEach(function(key2,index){  
					if(index+1 == keys.length){  
						that.$set(data,key2,val);  
					}else{  
						if(!data[key2]){  
							that.$set(data,key2,{});  
						}  
					}  
					data = data[key2];  
				})  
			});  
		} 
	}
	`;
	const ast = parse(code, {
		sourceType: 'module'
	});

	let result = null;
	traverse(ast, {
		ObjectProperty(path) {
			result = path.node;
		}
	});
	setDataFunAST = result;
	return result;
}


/**
 * 根据funName在liftCycleArr里查找生命周期函数，找不到就创建一个，给onLoad()里加入wxs所需要的代码
 * @param {*} liftCycleArr  生命周期函数数组
 * @param {*} key           用于查找当前编辑的文件组所对应的key
 * @param {*} funName       函数名："onLoad" or "beforeMount"
 */
function handleOnLoadFun(liftCycleArr, key, funName) {
	var node = null;
	for (let i = 0; i < liftCycleArr.length; i++) {
		const obj = liftCycleArr[i];
		if (obj.key.name == funName) {
			node = obj;
			break;
		}
	}
	let pageWxsInfo = global.pageWxsInfo[key];
	if (pageWxsInfo) {
		if (!node) {
			node = t.objectMethod("method", t.identifier(funName), [], t.blockStatement([]));
			liftCycleArr.unshift(node);
		}
		pageWxsInfo.forEach(obj => {
			let left = t.memberExpression(t.thisExpression(), t.identifier(obj.module));
			let right = t.identifier(obj.module);
			let exp = t.expressionStatement(t.assignmentExpression("=", left, right));
			if (node.body) {
				//处理 onLoad() {}
				node.body.body.unshift(exp);
			} else {
				//处理 onLoad: function() {}
				node.value.body.body.unshift(exp);
			}
		});
	}
	return node;
}

/**
 * 处理require()里的路径
 * @param {*} path      CallExpression类型的path，未做校验
 * @param {*} fileDir   当前文件所在目录
 */
function requireHandle(path, fileDir) {
	let callee = path.node.callee;
	if (t.isIdentifier(callee, { name: "require" })) {
		//处理require()路径
		let arguments = path.node.arguments;
		if (arguments && arguments.length) {
			if (t.isStringLiteral(arguments[0])) {
				let filePath = arguments[0].value;
				filePath = pathUtil.relativePath(filePath, global.miniprogramRoot, fileDir);
				path.node.arguments[0] = t.stringLiteral(filePath);
			}
		}
	}
}


/**
 * 处理未在data里面声明的变量
 * @param {*} ast 
 * @param {*} vistors 
 * @param {*} file_js 
 */
function defineValueHandle(ast, vistors, file_js) {
	//处理没有在data里面声明的变量
	var dataArr = vistors.data.getData();
	//转为json对象，这样方便查找
	let dataJson = {};
	dataArr.forEach(obj => {
		dataJson[obj.key.name] = obj.value.name;
	});
	traverse(ast, {
		noScope: true,
		CallExpression(path) {
			let callee = path.node.callee;
			if (t.isMemberExpression(callee)) {
				let object = callee.object;
				let property = callee.property;
				if (t.isIdentifier(property, { name: "setData" })) {
					let arguments = path.node.arguments;
					for (const key in arguments) {
						const element = arguments[key];
						for (const key2 in element.properties) {
							const subElement = element.properties[key2];
							if (t.isIdentifier(subElement.key)) {
								const name = subElement.key.name;
								const value = subElement.value;
								//与data对比
								if (!dataJson.hasOwnProperty(name)) {
									// const logStr = "data里没有的变量:    " + name + " -- " + value.type + "    file: " + nodePath.relative(global.miniprogramRoot, file_js);
									// console.log(logStr);

									//设置默认值
									let initialValue;
									switch (value.type) {
										case "BooleanLiteral":
											initialValue = t.booleanLiteral(false);
											break;
										case "NumericLiteral":
											initialValue = t.numericLiteral(0);
											break;
										case "ArrayExpression":
											initialValue = t.arrayExpression();
											break;
										case "ObjectExpression":
											initialValue = t.objectExpression([]);
											break;
										default:
											//其余全是空
											initialValue = t.stringLiteral("");
											break;
									}

									vistors.data.handle(t.objectProperty(t.identifier(name), initialValue));
									dataJson[name] = name;
								}
							}
						}
					}
				}
			}
		}
	});

}


/**
 * 调整ast里指定变量或函数名引用的指向
 * @param {*} ast 
 * @param {*} keyList  变量或函数名列表对象
 */
function repairValueAndFunctionLink(ast, keyList) {
	traverse(ast, {
		noScope: true,
		MemberExpression(path) {
			//this.uploadAnalysis = false --> this.$options.globalData.uploadAnalysis = false;
			//this.clearStorage() --> this.$options.globalData.clearStorage();
			const object = path.node.object;
			const property = path.node.property;
			const propertyName = property.name;
			if (keyList.hasOwnProperty(propertyName)) {
				if (t.isThisExpression(object) || t.isIdentifier(object, { name: "that" }) || t.isIdentifier(object, { name: "_this" }) || t.isIdentifier(object, { name: "self" }) || t.isIdentifier(object, { name: "_" })) {
					let subMe = t.MemberExpression(t.MemberExpression(object, t.identifier('$options')), t.identifier('globalData'));
					let me = t.MemberExpression(subMe, property);
					path.replaceWith(me);
					path.skip();
				}
			}
		}
	});
}

/**
 * 修复app.js函数和变量的引用关系
 * 1.this.uploadAnalysis = false --> this.$options.globalData.uploadAnalysis = false;
 * 2.this.clearStorage() --> this.$options.globalData.clearStorage();
 * @param {*} vistors 
 */
function repairAppFunctionLink(vistors) {
	//当为app.js时，不为空；globalData下面的key列表，用于去各种函数里替换语法
	let globalDataKeyList = {};
	const liftCycleArr = vistors.lifeCycle.getData();
	const methodsArr = vistors.methods.getData();

	//获取globalData中所有的一级字段
	for (let item of liftCycleArr) {
		let name = item.key.name;
		if (name == "globalData") {
			if (t.isObjectProperty(item)) {
				const properties = item.value.properties;
				for (const op of properties) {
					const opName = op.key.name;
					globalDataKeyList[opName] = opName;
				}
			}
		}
	}


	//进行替换生命周期里的函数
	for (let item of liftCycleArr) {
		let name = item.key.name;
		if (name !== "globalData") repairValueAndFunctionLink(item, globalDataKeyList);
	}


	//进行替换methods下面的函数, app.js已经不存在methods了
	// for (let item of methodsArr) {
	// 	let name = item.key.name;
	// 	repairValueAndFunctionLink(item, globalDataKeyList);
	// }
}


/**
 * 组件模板处理
 * @param {*} ast 
 * @param {*} vistors 
 * @param {*} isApp            是否为app.js文件
 * @param {*} usingComponents  使用的自定义组件列表
 * @param {*} isPage           判断当前文件是Page还是Component(还有第三种可能->App，划分到Page)
 * @param {*} wxsKey           获取当前文件wxs信息的key
 * @param {*} file_js          当前转换的文件路径
 * @param {*} isSingleFile     表示是否为单个js文件，而不是vue文件一部分
 */
const componentTemplateBuilder = function (ast, vistors, isApp, usingComponents, isPage, wxsKey, file_js, isSingleFile) {
	let buildRequire = null;

	//需要替换的函数名
	let replaceFunNameList = [];

	//存储data的引用，用于后面添加wxparse的数据变量
	let astDataPath = null;

	if (!isSingleFile) {
		defineValueHandle(ast, vistors, file_js);

		//
		if (isApp) {
			//是app.js文件,要单独处理
			buildRequire = template(componentTemplateApp);

			//methods全部移入到globalData
			const liftCycleArr = vistors.lifeCycle.getData();
			const methods = vistors.methods.getData();
			for (const item of liftCycleArr) {
				const keyName = item.key.name;
				if (keyName == "globalData") {
					item.value.properties = [...item.value.properties, ...methods];
				}
			}

			//20191028 回滚
			//[HBuilder X v2.3.7.20191024-alpha] 修复 在 App.vue 的 onLaunch 中，不支持 this.globalData 的 Bug
			// 修复app.js函数和变量的引用关系
			// repairAppFunctionLink(vistors);

			//占个位
			ast = buildRequire({
				METHODS: arrayToObject([])
			});

			// ast = buildRequire({
			// 	METHODS: arrayToObject(vistors.methods.getData())
			// });
		} else {
			//插入setData()
			const node = getSetDataFunAST();
			vistors.methods.handle(node);

			//非app.js文件
			buildRequire = template(componentTemplate);

			//处理data下变量名与函数重名的问题，或函数名为系统关键字，如delete等
			const dataArr = vistors.data.getData();
			let dataNameList = { "delete": true, "import": true }; //默认替换delete，import，暂定这几个关键字
			for (const item of dataArr) {
				dataNameList[item.key.name] = true;
			}

			const methods = vistors.methods.getData();
			for (const item of methods) {
				const keyName = item.key.name;
				if (dataNameList[keyName] || utils.isReservedTag(keyName)) {
					item.key.name += "Fun";
					replaceFunNameList.push(keyName);  //默认无重复吧，后期用set
					//留存全局变量，以便替换template
				}
			}

			//储存全局变量
			if (!global.pageData[file_js]) global.pageData[file_js] = {};
			global.pageData[file_js].replaceFunNameList = replaceFunNameList;

			//
			ast = buildRequire({
				PROPS: arrayToObject(vistors.props.getData()),
				DATA: arrayToObject(vistors.data.getData()),
				METHODS: arrayToObject(methods),
				COMPUTED: arrayToObject(vistors.computed.getData()),
				WATCH: arrayToObject(vistors.watch.getData()),
			});

			if (global.isTransformWXS) {
				//处理wxs里变量的引用问题
				let liftCycleArr = vistors.lifeCycle.getData();
				let funName = "beforeMount";
				if (isPage) funName = "onLoad";
				handleOnLoadFun(liftCycleArr, wxsKey, funName);
			}
		}
	}

	let fileDir = nodePath.dirname(file_js);
	//久久不能遍历，搜遍google，template也没有回调，后面想着源码中应该会有蛛丝马迹，果然，在templateVisitor里找到了看到这么一个属性noScope，有点嫌疑
	//noScope: 从babel-template.js中发现这么一个属性，因为直接转出来的ast进行遍历时会报错，找了官方文档，没有这个属性的介绍信息。。。
	//Error: You must pass a scope and parentPath unless traversing a Program/File. Instead of that you tried to traverse a ExportDefaultDeclaration node without passing scope and parentPath.
	//babel-template直接转出来的ast只是完整ast的一部分
	traverse(ast, {
		noScope: true,
		VariableDeclarator(path) {
			const init = path.get("init");
			if (t.isCallExpression(init) && init.node && t.isCallExpression(init.node)) {
				if (t.isIdentifier(init.node.callee, { name: "getApp" })) {
					/**
					 * var t = getApp();
					 * 替换为:
					 * var t = getApp().globalData;
					 */
					const me = t.memberExpression(t.callExpression(t.identifier("getApp"), []), t.identifier("globalData"));
					init.replaceWith(me);
					path.skip();
				}
			}
		},
		ObjectMethod(path) {
			// console.log("--------", path.node.key.name);
			if (path.node.key.name === 'data') {

				//存储data引用
				if (!astDataPath) astDataPath = path;

				//将require()里的地址都处理一遍
				traverse(path.node, {
					noScope: true,
					CallExpression(path2) {
						requireHandle(path2, fileDir);
					}
				});

				if (isApp) {
					var methodsArr = vistors.methods.getData();
					for (let key in methodsArr) {
						let obj = methodsArr[key];
						if (!t.isIdentifier(obj.key, { name: "setData" })) {
							path.insertAfter(obj);
						}
					}
				}

				//停止，不往后遍历了   //还是需要往后遍历，不然后getApp那些没法处理了
				// path.skip();
			}
		},
		ObjectProperty(path) {
			const name = path.node.key.name;
			if (name === 'components') {
				//import firstcompoent from '../firstcompoent/firstcompoent'
				//"firstcompoent": "../firstcompoent/firstcompoent"
				//
				// export default {
				// 	components: {
				// 	  ComponentA,
				// 	  ComponentC
				// 	},
				// }
				for (const key in usingComponents) {
					//中划线转驼峰
					let componentName = utils.toCamel2(key);

					//这里两个小优化空间
					//1.是否有其他操作这个数组方式
					//2.属性名与变量名相同是否可以合并为一个？ (解决，第三个参数：shorthand：true 即可)
					path.node.value.properties.push(t.objectProperty(
						t.identifier(componentName),
						t.identifier(componentName),
						false,
						true
					));
				}
			} else if (name === 'computed' || name === 'watch') {
				//这两个为空的话，会报错，所以删除，其他的不管先
				if (path.node.value && path.node.value.properties && path.node.value.properties.length == 0) path.remove();
			} else if (name === 'methods') {
				let liftCycleArr = vistors.lifeCycle.getData();
				for (let key in liftCycleArr) {
					// console.log(liftCycleArr[key]);
					path.insertBefore(liftCycleArr[key]);
				}
				//这里不能停止，否则后面的this.data.xxx不会被转换 20190918
				//path.skip();
			}
		},
		CallExpression(path) {
			let callee = path.get("callee");
			if (t.isMemberExpression(callee)) {
				let object = callee.get('object');
				let property = callee.get('property');
				if (t.isIdentifier(object, { name: "wx" }) && t.isIdentifier(property, { name: "createWorker" })) {
					//将wx.createWorker('workers/fib/index.js')转为wx.createWorker('./static/workers/fib/index.js');
					let arguments = path.node.arguments;
					if (arguments && arguments.length > 0) {
						let val = arguments[0].value;
						arguments[0] = t.stringLiteral("./static/" + val);
					}
				}
				//
				let objNode = object.node ? object.node : object;
				let propertyNode = property.node ? property.node : property;
				if (t.isIdentifier(objNode, { name: "WxParse" }) && t.isIdentifier(propertyNode, { name: "wxParse" })) {
					/**
					 * WxParse.wxParse(bindName , type, data, target,imagePadding)
					 * 1.bindName绑定的数据名(必填)
					 * 2.type可以为html或者md(必填)
					 * 3.data为传入的具体数据(必填)
					 * 4.target为Page对象,一般为this(必填)
					 * 5.imagePadding为当图片自适应是左右的单一padding(默认为0,可选)
					 */
					//解析WxParse.wxParse('contentT', 'html', content, this, 0);
					const arguments = path.node.arguments;

					//target为Page对象,一般为this(必填);这里大胆假设一下，只有this或this的别名，报错再说。
					const wxParseArgs = {
						bindName: "article_" + arguments[0].value,  //加个前缀以防冲突
						type: arguments[1].value,
						data: generate(arguments[2]).code,  //这里可能会有多种类型，so，直接转字符串
						target: t.isThisExpression(arguments[3]) ? "this" : arguments[3].name
					}

					//既然没法注释，那就存入日志吧。
					global.log.push("wxParse: " + generate(path).code + "      file: " + file_js);

					//将原来的代码注释
					babelUtil.addComment(path, `${generate(path.node).code}`);

					//替换节点
					//装13之选 ，一堆代码只为还原一行代码: setTimeout(function(){this.uParseArticle = contentData});
					var left = t.memberExpression(t.identifier(wxParseArgs.target), t.identifier(wxParseArgs.bindName), false);
					var right = t.identifier(wxParseArgs.data);
					var assExp = t.assignmentExpression("=", left, right);
					var bState = t.blockStatement([t.expressionStatement(assExp)]);
					var args = [t.functionExpression(null, [], bState)];
					var callExp = t.callExpression(t.identifier("setTimeout"), args);
					var expState = t.expressionStatement(callExp);
					path.replaceWith(expState);


					/////////////////////////////////////////////////////////////////
					//填充变量名到data里去，astDataPath理论上会有值，因为根据模板填充，data是居第一个，so，开搂~
					if (astDataPath) {
						try {
							//猜测使用get取的不是引用，而是clone的对象。
							// const properties = astDataPath.get("body.body.0.argument.properties");

							const properties = astDataPath.node.body.body[0].argument.properties;
							const op = t.objectProperty(t.Identifier(wxParseArgs.bindName), t.stringLiteral(""));
							properties.push(op);
						} catch (error) {
							const logStr = "Error:    " + error + "   source: astDataPath.get(\"body.body.0.argument.properties\")" + "    file: " + file_js;
							//存入日志，方便查看，以防上面那么多层级搜索出问题
							utils.log(logStr);
							global.log.push(logStr);
						}
					}
				} else {
					babelUtil.globalDataHandle(callee);
				}
			} else {
				requireHandle(path, fileDir);
			}

			// if (t.isIdentifier(callee, { name: "getApp" })) {
			// 	/**
			// 	 * getApp().xxx; 
			// 	 * 替换为:
			// 	 * getApp().globalData.xxx;
			// 	 * 
			// 	 * 注：因为已经把var app = getApp()替换掉了，所以这里可以放心的替换
			// 	 */
			// 	let arguments = path.node.arguments;
			// 	if (arguments.length == 0) {
			// 		const parent = path.parent;
			// 		if (parent && parent.property && t.isIdentifier(parent.property, { name: "globalData" })) {
			// 			//如果已经getApp().globalData就不进行处理了
			// 		} else {
			// 			//一般来说getApp()是没有参数的。
			// 			path.replaceWith(t.memberExpression(t.callExpression(t.identifier("getApp"), []), t.identifier("globalData")));
			// 			path.skip();
			// 		}
			// 	}
			// }
		},
		MemberExpression(path) {
			let object = path.get('object');
			let property = path.get('property');

			if (t.isIdentifier(property.node, { name: "triggerEvent" })) {
				//this.triggerEvent()转换为this.$emit()
				let obj = t.memberExpression(object.node, t.identifier("$emit"));
				path.replaceWith(obj);
			} else if (t.isIdentifier(property.node, { name: "data" })) {
				//将this.data.xxx转换为this.xxx
				if (t.isThisExpression(object) || t.isIdentifier(object.node, { name: "that" }) || t.isIdentifier(object.node, { name: "_this" }) || t.isIdentifier(object.node, { name: "self" }) || t.isIdentifier(object.node, { name: "_" })) {
					let parent = path.parent;
					//如果父级是AssignmentExpression，则不需再进行转换
					if (parent && !t.isAssignmentExpression(parent)) {
						path.replaceWith(object);
					}
				}
			} else if (t.isIdentifier(object.node, { name: "app" }) || t.isIdentifier(object.node, { name: "App" })) {
				//app.xxx ==> app.globalData.xxx
				// let me = t.MemberExpression(t.MemberExpression(object.node, t.identifier('globalData')), property.node);
				// path.replaceWith(me);
				// path.skip();

				//这里先注释，貌似不用走到这里来----------------------------
				// babelUtil.globalDataHandle(object);
			}

			//替换与data变量重名的函数引用
			for (const item of replaceFunNameList) {
				if (t.isIdentifier(property.node, { name: item })) {
					if (t.isThisExpression(object) || t.isIdentifier(object.node, { name: "that" }) || t.isIdentifier(object.node, { name: "_this" }) || t.isIdentifier(object.node, { name: "self" }) || t.isIdentifier(object.node, { name: "_" })) {
						let parent = path.parent;
						//如果父级是AssignmentExpression，则不需再进行转换
						if (parent && !t.isAssignmentExpression(parent)) {
							property.node.name = item + "Fun";
						}
					}
				}
			}

			//如果是在log("ischeck=====", app.data.isCheck);里
			//或在 xx:function(){
			//	that.setData({
			//		isCheck: app.data.isCheck
			//	  });
			//}
			if (t.isMemberExpression(object)) {
				babelUtil.globalDataHandle(object);
			} else {
				babelUtil.globalDataHandle(path);
			}



			//20191028 回滚
			//[HBuilder X v2.3.7.20191024-alpha] 修复 在 App.vue 的 onLaunch 中，不支持 this.globalData 的 Bug
			// if (isApp) {
			// 	//仅在App.vue里将this.globalData.xxx转换为this.$options.globalData.xxx
			// 	//这里是暂时方案，后缀可能屏蔽(现在是uni-app无法支持this.globalData方式)
			// 	if (t.isThisExpression(object) || t.isIdentifier(object.node, { name: "that" }) || t.isIdentifier(object.node, { name: "_this" })) {
			// 		if (t.isIdentifier(property.node, { name: "globalData" })) {
			// 			let me = t.MemberExpression(t.MemberExpression(object.node, t.identifier('$options')), t.identifier('globalData'));
			// 			path.replaceWith(me);
			// 			path.skip();
			// 		}
			// 	}

			// 	if (t.isCallExpression(object.node) && t.isIdentifier(object.node.callee, { name: "getApp" })) {
			// 		// getApp().data.A4SingleBlack = 1  -->  this.$option.globalDatagetApp().data.A4SingleBlack = 1

			// 		let me = t.MemberExpression(t.MemberExpression(t.ThisExpression(), t.identifier('$options')), t.identifier('globalData'));
			// 		path.replaceWith(me);
			// 		path.skip();
			// 	}
			// }

			//解决this.setData的问题
			//20190719 
			//因为存在含有操作setData的三元表达式，如：
			//"block" == this.data.listmode ? this.setData({
			// 		listmode: ""
			// }) : this.setData({
			//		 listmode: "block"
			// })
			//和 this使用其他变量代替的情况，所以
			//回归初次的解决方案，使用一个setData()函数来替代。
			//
			// let object = path.get('object');
			// let property = path.get('property');
			// //
			// let parent = path.parent;

			// if (t.isThisExpression(object)) {
			// 	if (t.isIdentifier(property.node, { name: "setData" })) {
			// 		//如果是this.setData()时
			// 		handleSetData(path, true);
			// 	} else if (t.isIdentifier(property.node, { name: "data" })) {
			// 		//将this.data替换为this
			// 		path.replaceWith(t.thisExpression());
			// 	}
			// } else if (t.isIdentifier(property.node, { name: "setData" })) {
			// 	if (t.isIdentifier(object.node, { name: "that" })) {
			// 		//如果是that.setData()时
			// 		handleSetData(path);
			// 	}
			// }
			//
			//uni-app 支持getApp() 这里不作转换
			// if (t.isIdentifier(object.node, { name: "app" })) {
			// 	if (t.isIdentifier(property.node, { name: "globalData" })) {
			// 		//app.globalData.xxx的情况 
			// 		object.replaceWith(t.thisExpression());
			// 	} else {
			// 		//app.fun()的情况 这种不管
			// 	}
			// } else if (t.isCallExpression(object.node) && t.isIdentifier(path.get('object.callee').node, { name: "getApp" })) {
			// 	//getApp().globalData.userInfo => this.globalData.userInfo
			// 	object.replaceWith(t.thisExpression());
			// }
		},
	});
	return ast;
}

/**
 * 处理js文件里面所有的符合条件的资源路径
 * @param {*} ast 
  * @param {*} file_js 
 */
function handleJSImage(ast, file_js) {
	traverse(ast, {
		noScope: true,
		StringLiteral(path) {
			let reg = /\.(jpg|jpeg|gif|svg|png)$/;  //test时不能加/g

			//image标签，处理src路径
			var src = path.node.value;

			//这里取巧一下，如果路径不是以/开头，那么就在前面加上./
			if (!/^\//.test(src)) {
				src = "./" + src;
			}

			//忽略网络素材地址，不然会转换出错
			if (src && !utils.isURL(src) && reg.test(src)) {
				//static路径
				let staticPath = nodePath.join(global.miniprogramRoot, "static");

				//当前处理文件所在目录
				let jsFolder = nodePath.dirname(file_js);
				var pFolderName = pathUtil.getParentFolderName(src);
				var fileName = nodePath.basename(src);

				let filePath = nodePath.resolve(staticPath, "./" + pFolderName + "/" + fileName);
				let newImagePath = nodePath.relative(jsFolder, filePath);

				path.node = t.stringLiteral(newImagePath);
				// console.log("newImagePath ", newImagePath);
			}
		},
	});
}

/**
 * 1.判断是否为vue文件，小程序项目里，有可能会有含vue语法的文件，如https://github.com/dmego/together/
 * 2.顺便修复一下
 * @param {*} ast 
 */
function checkVueFile(ast) {
	let isVueFile = false;
	if (ast && ast.program && ast.program.body) {
		const body = ast.program.body;
		for (const key in body) {
			const obj = body[key];
			if (t.isExportDefaultDeclaration(obj)) {
				isVueFile = true;
			}
		}
	}
	return isVueFile;
}

/**
 * js 处理入口方法
 * @param {*} fileData          要处理的文件内容 
 * @param {*} isApp             是否为入口app.js文件
 * @param {*} usingComponents   使用的自定义组件列表
 * @param {*} miniprogramRoot   小程序目录
 * @param {*} file_js           当前处理的文件路径
 * @param {*} isSingleFile      表示是否为单个js文件，而不是vue文件一部分
 */
async function jsHandle(fileData, isApp, usingComponents, miniprogramRoot, file_js, isSingleFile) {
	//先反转义
	let javascriptContent = fileData;

	//初始化一个解析器
	let javascriptParser = new JavascriptParser();

	//去除无用代码
	javascriptContent = javascriptParser.beforeParse(javascriptContent);

	let javascriptAst = null;
	let isParseError = false; //标识是否解析报错
	try {
		//解析成AST
		javascriptAst = await javascriptParser.parse(javascriptContent);
	} catch (error) {
		isParseError = true;
		const logStr = "Error: 解析文件出错: " + error + "      file: " + file_js;
		utils.log(logStr);
		global.log.push(logStr);
	}

	//是否为vue文件
	const isVueFile = checkVueFile(javascriptAst);

	//进行代码转换
	let {
		convertedJavascript,
		vistors,
		declareStr,
		isPage
	} = componentConverter(javascriptAst, miniprogramRoot, file_js, isVueFile);

	if (!global.isVueAppCliMode) {
		//处理js里面的资源路径
		handleJSImage(javascriptAst, file_js);
	}

	let wxsKey = "";
	if (global.isTransformWXS) {
		//添加wxs引用
		wxsKey = nodePath.join(nodePath.dirname(file_js), pathUtil.getFileNameNoExt(file_js));
		let pageWxsInfo = global.pageWxsInfo[wxsKey];
		if (pageWxsInfo) {
			pageWxsInfo.forEach(obj => {
				if (obj.type == "link") declareStr += `import ${obj.module} from '${obj.src}'\r\n`;
			});
		}
	}


	//引入自定义组件
	//import firstcompoent from '../firstcompoent/firstcompoent'
	let jsFolder = nodePath.dirname(file_js);
	for (const key in usingComponents) {
		let filePath = usingComponents[key];

		//相对路径处理
		filePath = pathUtil.relativePath(filePath, global.miniprogramRoot, jsFolder);

		//中划线转驼峰
		let componentName = utils.toCamel2(key);
		//
		let node = t.importDeclaration([t.importDefaultSpecifier(t.identifier(componentName))], t.stringLiteral(filePath));
		declareStr += `${generate(node).code}\r\n`;
	}

	if (!isVueFile) {
		//放到预先定义好的模板中
		convertedJavascript = componentTemplateBuilder(javascriptAst, vistors, isApp, usingComponents, isPage, wxsKey, file_js, isSingleFile);
	}

	// console.log(`${generate(convertedJavascript).code}`);

	//生成文本并写入到文件
	let codeText = "";
	if (isSingleFile) {
		codeText = `${generate(convertedJavascript).code}`;
	} else {
		codeText = `<script>\r\n${declareStr}\r\n${generate(convertedJavascript).code}\r\n</script>\r\n`;
	}

	//如果解析报错，那么还是返回原文件内容
	if (!codeText && isParseError) {
		codeText = fileData;
	}
	return codeText;
}
module.exports = jsHandle;
