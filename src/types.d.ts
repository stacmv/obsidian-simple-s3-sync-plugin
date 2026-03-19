declare module "picomatch" {
	function picomatch(
		glob: string | string[],
		options?: Record<string, any>
	): (input: string) => boolean;
	export = picomatch;
}
